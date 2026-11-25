// Plain text from a Word .docx file, with no extra library: a .docx is a zip file, and the text is in
// word/document.xml. The browser's own DecompressionStream unzips it. Paragraphs become lines; an empty
// paragraph (a blank line in Word) becomes a blank line, so captions separated that way stay separate.

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Finds one file in the zip using the central directory (sizes there are reliable). */
async function unzipEntry(buf: ArrayBuffer, wanted: string): Promise<Uint8Array | null> {
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // End of central directory record: signature 0x06054b50, within the last 64 KB.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This isn't a Word (.docx) file.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= buf.byteLength; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error("This Word file uses a compression the browser can't read. Save it again from Word and retry.");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

export async function docxText(file: File): Promise<string> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't read Word files. Use Chrome or Edge, or save it as .txt.");
  const xml = await unzipEntry(await file.arrayBuffer(), "word/document.xml");
  if (!xml) throw new Error("No text found in this Word file.");
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  // Text boxes are stored twice (a modern copy and an "mc:Fallback" copy for old Word) and their paragraphs sit
  // inside another paragraph: read each piece of text once.
  const inFallback = (n: Element) => {
    for (let p = n.parentElement; p; p = p.parentElement) if (p.localName === "Fallback") return true;
    return false;
  };
  const nestedPara = (n: Element) => {
    for (let p = n.parentElement; p; p = p.parentElement) if (p.localName === "p" && p.namespaceURI === W) return true;
    return false;
  };
  const paras: string[] = [];
  for (const para of Array.from(doc.getElementsByTagNameNS(W, "p"))) {
    if (inFallback(para)) continue;
    let line = "";
    for (const node of Array.from(para.getElementsByTagNameNS(W, "*"))) {
      if (inFallback(node)) continue;
      // Text in a text box belongs to the box's own paragraphs, which are read separately.
      let owner: Element | null = node.parentElement;
      while (owner && !(owner.localName === "p" && owner.namespaceURI === W)) owner = owner.parentElement;
      if (owner !== para) continue;
      if (node.localName === "t") line += node.textContent ?? "";
      else if (node.localName === "tab") line += "\t";
      else if (node.localName === "br" || node.localName === "cr") line += "\n";
    }
    if (nestedPara(para) || line.trim() || paras.length) paras.push(line);
  }
  // Captions are separated by an empty paragraph (a blank line in Word): mark each break with "---", the
  // separator the Style Bot already understands, so every caption is learned on its own.
  const captions: string[] = [];
  let cur: string[] = [];
  for (const p of paras) {
    if (p.trim()) cur.push(p);
    else if (cur.length) {
      captions.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length) captions.push(cur.join("\n"));
  return captions.join("\n---\n").trim();
}
