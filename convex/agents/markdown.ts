// A deliberately small Markdown renderer for the agent-facing pages in
// ./pages.ts. It covers exactly the subset those pages are written in
// (headings, paragraphs, lists, fenced code, links, `code`, **bold**), so
// one Markdown source serves both the .md twin and the HTML page.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];

  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);

    if (list.length)
      out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    paragraph = [];
    list = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];

      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // A table: a header row, a `| --- |` rule, then body rows.
    if (line.startsWith("|") && /^\|[\s|:-]+\|$/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line).map((cell) => `<th>${inline(cell)}</th>`);
      const rows: string[] = [];

      for (i += 2; i < lines.length && lines[i].startsWith("|"); i++)
        rows.push(
          `<tr>${cells(lines[i])
            .map((cell) => `<td>${inline(cell)}</td>`)
            .join("")}</tr>`,
        );
      i--;
      out.push(
        `<table><thead><tr>${head.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3}) (.*)$/);

    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (line.startsWith("- ")) {
      if (paragraph.length) flush();
      list.push(line.slice(2));
    } else if (!line.trim() || line === "---") {
      flush();
    } else if (list.length && line.startsWith("  ")) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      if (list.length) flush();
      paragraph.push(line.trim());
    }
  }

  flush();

  return out.join("\n");
}
