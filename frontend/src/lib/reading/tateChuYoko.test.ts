// 纵中横 (tate-chu-yoko): in a vertical column, a run of digits reads as one
// horizontal cell. The wrapping must not touch digits the document owns —
// attributes, an existing span, a number already inside an element.

import { describe, it, expect } from "vitest";
import { tateChuYoko } from "./tateChuYoko";

describe("tateChuYoko", () => {
  it("wraps a bare 2–4 digit run", () => {
    expect(tateChuYoko("<p>宋淳熙三年（1176）刻本。</p>")).toBe(
      '<p>宋淳熙三年（<span class="tcy">1176</span>）刻本。</p>',
    );
  });

  it("wraps every run in the paragraph, short and long", () => {
    expect(tateChuYoko("<p>卷12，成书于1076年，时年76。</p>")).toBe(
      '<p>卷<span class="tcy">12</span>，成书于<span class="tcy">1076</span>年，时年<span class="tcy">76</span>。</p>',
    );
  });

  it("leaves digits inside a tag alone", () => {
    expect(tateChuYoko('<p data-n="1176">正文</p>')).toBe('<p data-n="1176">正文</p>');
  });

  it("leaves single digits and runs of five or more alone", () => {
    expect(tateChuYoko("<p>第3卷，凡12345字，计6册。</p>")).toBe(
      "<p>第3卷，凡12345字，计6册。</p>",
    );
  });

  it("does not wrap what is already wrapped", () => {
    expect(tateChuYoko('<p><span class="tcy">12</span>文</p>')).toBe(
      '<p><span class="tcy">12</span>文</p>',
    );
  });

  it("leaves an existing tcy cell with extra classes and attrs alone", () => {
    expect(tateChuYoko('<p><span class="tcy extra" data-n="1">12</span></p>')).toBe(
      '<p><span class="tcy extra" data-n="1">12</span></p>',
    );
  });

  it("does not split a run across a tag boundary", () => {
    expect(tateChuYoko("<p>123<br>456</p>")).toBe(
      '<p><span class="tcy">123</span><br><span class="tcy">456</span></p>',
    );
  });

  it("leaves numeric character references alone", () => {
    // The digits of &#8212; are the *name* of a character, not text to
    // combine — wrapping them would render the literal "&8212;".
    expect(tateChuYoko("<p>宋——&#8212;刻本&#x2014;。</p>")).toBe(
      "<p>宋——&#8212;刻本&#x2014;。</p>",
    );
  });

  it("wraps fullwidth digits the same way", () => {
    expect(tateChuYoko("<p>成书于１１７６年。</p>")).toBe(
      '<p>成书于<span class="tcy">１１７６</span>年。</p>',
    );
  });

  it("stands a short Latin token as one cell", () => {
    expect(tateChuYoko("<p>见 OK 与 CD。</p>")).toBe(
      '<p>见 <span class="tcy">OK</span> 与 <span class="tcy">CD</span>。</p>',
    );
  });

  it("stands doubled bangs and questions as one cell", () => {
    expect(tateChuYoko("<p>岂有此理！！真的？？</p>")).toBe(
      '<p>岂有此理<span class="tcy">！！</span>真的<span class="tcy">？？</span></p>',
    );
  });

  it("stands mixed bangs and questions, and a double ellipsis, as one cell", () => {
    expect(tateChuYoko("<p>真的!?難道？！那……</p>")).toBe(
      '<p>真的<span class="tcy">!?</span>難道<span class="tcy">？！</span>那<span class="tcy">……</span></p>',
    );
  });

  it("leaves a Latin word alone", () => {
    expect(tateChuYoko("<p>Chapter notes。</p>")).toBe("<p>Chapter notes。</p>");
  });

  it("wraps a run next to an entity without touching the entity", () => {
    expect(tateChuYoko("<p>凡12&#8212;13卷。</p>")).toBe(
      '<p>凡<span class="tcy">12</span>&#8212;<span class="tcy">13</span>卷。</p>',
    );
  });

  it("stands a measure as one cell with its unit", () => {
    expect(tateChuYoko("<p>长12cm，约3%。</p>")).toBe(
      '<p>长<span class="tcy">12cm</span>，约<span class="tcy">3%</span>。</p>',
    );
  });

  it("stands a fullwidth measure as one cell", () => {
    expect(tateChuYoko("<p>约３％。</p>")).toBe('<p>约<span class="tcy">３％</span>。</p>');
  });

  it("stands a fullwidth Latin token the same way", () => {
    expect(tateChuYoko("<p>见ＯＫ。</p>")).toBe('<p>见<span class="tcy">ＯＫ</span>。</p>');
  });

  it("stands a unicode roman numeral as one cell", () => {
    expect(tateChuYoko("<p>卷Ⅷ。</p>")).toBe('<p>卷<span class="tcy">Ⅷ</span>。</p>');
  });

  it("leaves a single roman numeral Ⅰ alone", () => {
    expect(tateChuYoko("<p>卷Ⅰ。</p>")).toBe("<p>卷Ⅰ。</p>");
  });

  it("wraps only the era year digits", () => {
    expect(tateChuYoko("<p>令和6年、平成31年</p>")).toBe(
      '<p>令和<span class="tcy">6</span>年、平成<span class="tcy">31</span>年</p>',
    );
  });

  it("wraps each date particle's digits", () => {
    expect(tateChuYoko("<p>12年3月4日</p>")).toBe(
      '<p><span class="tcy">12</span>年<span class="tcy">3</span>月<span class="tcy">4</span>日</p>',
    );
  });

  it("stands a closed number range as one cell", () => {
    expect(tateChuYoko("<p>卷12〜15</p>")).toBe('<p>卷<span class="tcy">12〜15</span></p>');
    expect(tateChuYoko("<p>卷１２～１５</p>")).toBe(
      '<p>卷<span class="tcy">１２～１５</span></p>',
    );
  });

  it("stands circled numerals as one cell", () => {
    expect(tateChuYoko("<p>①と㊀</p>")).toBe(
      '<p><span class="tcy">①</span>と<span class="tcy">㊀</span></p>',
    );
  });
});
