import { describe, it, expect } from "vitest";
import { linesFromRuns, blocksFromLines, type Line } from "./pdfText";

/** A run as pdf.js hands it over: [,,,size,x,y]. */
const run = (str: string, x: number, y: number, size = 10, width = str.length * size, hasEOL = false) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  hasEOL,
});

/** A line, for the paragraph rules. */
const line = (text: string, x: number, y: number, right = 400, size = 10, page = 1): Line => ({
  text,
  x,
  right,
  y,
  size,
  page,
});

describe("putting runs back into lines", () => {
  it("joins the runs of a line and stops where the line does", () => {
    const lines = linesFromRuns(
      [run("我不是", 50, 700), run("教你诈", 80, 700, 10, 30, true), run("下一行", 50, 680, 10, 30, true)],
      3,
    );
    expect(lines.map((l) => l.text)).toEqual(["我不是教你诈", "下一行"]);
    expect(lines[0]).toMatchObject({ x: 50, y: 700, size: 10, page: 3 });
    expect(lines[0].right).toBe(110);
  });

  it("has nothing to say about a page of pictures", () => {
    expect(linesFromRuns([run("   ", 0, 0, 10, 0, true)], 1)).toEqual([]);
    expect(linesFromRuns([], 1)).toEqual([]);
  });
});

describe("putting lines back into paragraphs", () => {
  // The rule that carries most of the weight: Chinese sets a paragraph's first
  // line two characters in.
  it("starts a paragraph at an indent", () => {
    const blocks = blocksFromLines([
      line("　　第一段的开头，一直写到右边。", 74, 700),
      line("第一段的第二行，也写到右边。", 50, 680),
      line("　　第二段的开头，同样到右边。", 74, 660),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain("第一段的第二行");
    expect(blocks[1].text).toContain("第二段的开头");
  });

  it("ends a paragraph at a line that stops short", () => {
    const blocks = blocksFromLines([
      line("满行的一句，写到最右边。", 50, 700, 400),
      line("这一行只有半句。", 50, 680, 300), // ends well short
      line("下一段的第一行，写到最右。", 50, 660, 400),
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("breaks where the page leaves a gap", () => {
    const blocks = blocksFromLines([
      line("上一段。", 50, 700, 400),
      line("紧接的一行。", 50, 680, 400),
      line("隔了一大段空白之后。", 50, 600, 400), // four line-heights down
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("reads larger type as a heading, and does not run it into the prose", () => {
    const blocks = blocksFromLines([
      line("何必逼人太甚", 50, 700, 200, 16),
      line("陈教授才进场，王主编就冲了过去。", 50, 660, 400, 10),
      line("接下来的一行。", 50, 640, 400, 10),
    ]);
    expect(blocks[0]).toMatchObject({ kind: "heading", text: "何必逼人太甚" });
    expect(blocks[1].kind).toBe("para");
    expect(blocks[1].text).toContain("接下来的一行");
  });

  // Running heads and folios repeat page after page; prose does not.
  it("drops the furniture", () => {
    const lines: Line[] = [];
    for (let p = 1; p <= 5; p++) {
      lines.push(line("我不是教你诈", 50, 760, 200, 8, p)); // running head
      lines.push(line(`${p * 10}`, 300, 40, 320, 8, p)); // folio
      lines.push(line(`第${p}页的正文，写到右边为止。`, 50, 700, 400, 10, p));
    }
    const blocks = blocksFromLines(lines);
    expect(blocks.every((b) => !b.text.includes("我不是教你诈"))).toBe(true);
    expect(blocks.every((b) => !/^\d+$/.test(b.text))).toBe(true);
    expect(blocks).toHaveLength(5);
  });

  it("joins a line break the way the script does", () => {
    const cjk = blocksFromLines([line("中文上一行", 50, 700, 400), line("接下一行", 50, 680, 400)]);
    expect(cjk[0].text).toBe("中文上一行接下一行");
    const latin = blocksFromLines([line("the quick brown", 50, 700, 400), line("fox jumps", 50, 680, 400)]);
    expect(latin[0].text).toBe("the quick brown fox jumps");
  });

  it("carries a paragraph across a page break", () => {
    const blocks = blocksFromLines([
      line("这一段在上一页结束前还没写完，", 50, 100, 400, 10, 7),
      line("在下一页接着写完。", 50, 700, 400, 10, 8),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].page).toBe(7);
  });

  it("has nothing to reflow in an empty stretch", () => {
    expect(blocksFromLines([])).toEqual([]);
  });
});
