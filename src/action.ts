import path, { sep, join, resolve } from "path"
import { readFileSync } from "fs"
import { exec } from "@actions/exec"
import * as core from "@actions/core"
import { getOctokit, context } from "@actions/github"
import type { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods"
import flatMap from "lodash/flatMap"
import filter from "lodash/filter"
import strip from "strip-ansi"
import { createCoverageMap, CoverageMapData, CoverageSummary } from "istanbul-lib-coverage"
import type { FormattedTestResults } from "@jest/test-result/build/types"

const ACTION_NAME = "jest-github-action"
const COVERAGE_HEADER = "# :open_umbrella: Code Coverage";
const CHAR_LIMIT = 60000;

const rootPath = process.cwd();

type File = {
  relative: string;
  fileName: string;
  path: string;
  coverage: CoverageSummary;
};

export async function run() {
  let workingDirectory = core.getInput("working-directory", { required: false })
  let cwd = workingDirectory ? resolve(workingDirectory) : process.cwd()
  const CWD = cwd + sep
  const RESULTS_FILE = join(CWD, "report.json")

  try {
    const token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    const std = await execJest(getJestCommand(), CWD)

    // octokit
    const octokit = getOctokit(token)

    // Parse results
    const results = parseResults(RESULTS_FILE)

    // Finish successfully if there is no report
    if (!results) {
      console.error("There is no report.json file, finish gracefully.")
      return;
    }

    // Checks
    const checkPayload = getCheckPayload(results, CWD, std)
    await octokit.rest.checks.create(checkPayload)

    // Coverage comments
    if (getPullId() && shouldCommentCoverage()) {
      const comment = getCoverageTable(results, CWD)
      if (comment) {
        await deletePreviousComments(octokit)
        const commentPayload = getCommentPayload(comment)
        await octokit.rest.issues.createComment(commentPayload)
      }
    }

    if (!results?.success) {
      core.setFailed("Some jest tests failed.")
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

async function deletePreviousComments(octokit: ReturnType<typeof getOctokit>) {
  const { data } = await octokit.rest.issues.listComments({
    ...context.repo,
    per_page: 100,
    issue_number: getPullId(),
  })
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user?.login === "github-actions[bot]" && c.body?.startsWith(COVERAGE_HEADER),
      )
      .map((c) => octokit.rest.issues.deleteComment({ ...context.repo, comment_id: c.id })),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

function formatIfPoor(number: number): string {
  if (number > 80) {
      return `${number} :green_circle:`;
  }
  if (number > 65) {
      return `${number} :yellow_circle:`;
  }
  if (number > 50) {
      return `${number} :orange_circle:`;
  }
  return `${number} :red_circle:`;
}

const summaryToRow = (f: CoverageSummary) => [
  formatIfPoor(f.statements.pct!),
  formatIfPoor(f.branches.pct!),
  formatIfPoor(f.functions.pct!),
  formatIfPoor(f.lines.pct!),
];

function toHTMLTable(headers: string[], rows: string[][]): string
{
    const headerHtml = toHTMLTableRow([headers], cell => `<th>${cell}</th>`, 'thead');
    const bodyHtml = toHTMLTableRow(rows, (cell, i) => `<td${i > 0 ? ' nowrap="nowrap" align="right"' : ''}>${cell}</td>`, 'tbody');

    return [
        '<table width="100%">',
        headerHtml,
        bodyHtml,
        '</table>',
    ].join("");
}

function toHTMLTableRow(rows: string[][], formatCellCB: (cell: string, i: number) => string, wrapperElement: string): string
{
    return `<${wrapperElement}>${rows.map(row => `<tr>${row.map(formatCellCB).join("")}</tr>`).join("")}</${wrapperElement}>`;
}

const groupByPath = (dirs: { [key: string]: File[] }, file: File) => {
  if (!(file.path in dirs)) {
      dirs[file.path] = [];
  }

  dirs[file.path].push(file);

  return dirs;
};

function truncateLeft(str: string, len: number): string
{
    if(len > str.length) {
        return str;
    }

    const subStr = str.substring(str.length - len);

    return `...${subStr}`;
}

function truncateRight(str: string, len: number): string
{
    if(len > str.length) {
        return str;
    }

    const subStr = str.substring(0, len);

    return `${subStr}...`;
}

export function getCoverageTable(
  results: FormattedTestResults,
  cwd: string,
): string | false {
  if (!results.coverageMap) {
    return ""
  }
  const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)

  if (!Object.keys(covMap.data).length) {
    console.error("No entries found in coverage data")
    return false
  }

  const headers = ["% Stmts", "% Branch", "% Funcs", "% Lines"];
  const summary = summaryToRow(covMap.getCoverageSummary());
  const summaryTable = toHTMLTable(headers, [summary]);

  const parseFile = (absolute: string) => {
    const relative = path.relative(rootPath, absolute);
    const fileName = path.basename(relative);
    const p = path.dirname(relative);
    const coverage = covMap.fileCoverageFor(absolute).toSummary();
    return { relative, fileName, path: p, coverage };
  };
  const fullHeaders = ["File", ...headers];
  const files = covMap.files().map(parseFile).reduce(groupByPath, {});
  const rows = Object.entries(files)
        .map(([dir, files]) => [
            [`<b>${truncateLeft(dir, 50)}</b>`, "", "", "", ""], // Add metrics for directories by summing files
            ...files.map((file) => ([
                `<code>${file.fileName}</code>`,
                ...summaryToRow(file.coverage)
            ])),
        ])
        .flat();
  const fullTable = toHTMLTable(fullHeaders, rows);

  const lines = [
    COVERAGE_HEADER,
    summaryTable,
    "",
    '<details>',
    '<summary>Click to expand</summary>\n',
    fullTable,
    '</details>'
  ];
  return lines.join("\n");
}

function getCommentPayload(body: string) {
  const payload: RestEndpointMethodTypes["issues"]["createComment"]["parameters"] = {
    ...context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(results: FormattedTestResults, cwd: string, {out, err}: {out?: string, err?: string}) {
  const payload: RestEndpointMethodTypes["checks"]["create"]["parameters"] = {
    ...context.repo,
    head_sha: getSha(),
    name: ACTION_NAME,
    status: "completed",
    conclusion: results.success ? "success" : "failure",
    output: {
      title: results.success ? "Jest tests passed" : "Jest tests failed",
      text: truncateRight(`${out ? out : ''}${err ? `\n\n${err}` : ''}`, CHAR_LIMIT),
      summary: results.success
        ? `${results.numPassedTests} tests passing in ${
            results.numPassedTestSuites
          } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
        : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`,

      annotations: getAnnotations(results, cwd),
    },
  }
  return payload
}

function getJestCommand() {
  return core.getInput("test-command", { required: true })
}

function parseResults(resultsFile: string): FormattedTestResults | null {
  try {
    return JSON.parse(readFileSync(resultsFile, "utf-8"))
  } catch(e) {
    return null
  }
}

async function execJest(cmd: string, cwd?: string) {
  let out = Buffer.concat([], 0)
  let err = Buffer.concat([], 0)

  try {
    const options: Parameters<typeof exec>[2] = {
      cwd,
      silent: true
    };
    options.listeners = {
      stdout: (data: Buffer) => {
        out = Buffer.concat([out, data], out.length + data.length)
      },
      stderr: (data: Buffer) => {
        err = Buffer.concat([err, data], err.length + data.length)
      }
    };
    await exec(cmd, [], options)


    console.debug("Jest command executed")
  } catch (e) {
    console.error("Jest execution failed. Tests have likely failed.", e)
  }

  return { out: out.toString(), err: err.toString() };
}

function getPullId(): number {
  return context.payload.pull_request?.number ?? 0
}

function getSha(): string {
  return context.payload.pull_request?.head.sha ?? context.sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): Object[] => {
  if (results.success) {
    return []
  }
  return flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
}

export function asMarkdownCode(str: string) {
  return "```\n" + str.trimRight() + "\n```"
}
