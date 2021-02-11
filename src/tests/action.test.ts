import { asMarkdownCode } from "../action"

describe("asMarkdownCode()", () => {
  it("should return a markdown formated code", () => {
    expect(asMarkdownCode("hello")).toStrictEqual("```\nhello\n```")
  })
})
