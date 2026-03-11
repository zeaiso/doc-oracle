import chalk from "chalk";

function renderCodeBlock(code: string, lang: string): string {
  const border = chalk.dim("  │ ");
  const header = lang ? chalk.dim(`  ┌─ ${lang} `) + chalk.dim("─".repeat(Math.max(0, 50 - lang.length))) : chalk.dim("  ┌" + "─".repeat(54));
  const footer = chalk.dim("  └" + "─".repeat(54));

  const lines = code
    .split("\n")
    .map((line) => border + chalk.cyan(line))
    .join("\n");

  return `\n${header}\n${lines}\n${footer}\n`;
}

function renderInlineCode(text: string): string {
  return chalk.bgGray.white(` ${text} `);
}

function renderHeading(text: string, level: number): string {
  const prefix = level === 1 ? "# " : level === 2 ? "## " : "### ";
  return "\n" + chalk.bold.white(prefix + text) + "\n";
}

function renderBold(text: string): string {
  return chalk.bold(text);
}

function renderListItem(text: string): string {
  return chalk.dim("  • ") + text;
}

function renderLine(line: string): string {
  let result = line;

  result = result.replace(/`([^`]+)`/g, (_, code) => renderInlineCode(code));
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, text) => renderBold(text));

  return result;
}

export function renderMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      output.push(renderCodeBlock(codeLines.join("\n"), lang));
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      output.push(renderHeading(line.slice(4), 3));
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      output.push(renderHeading(line.slice(3), 2));
      i++;
      continue;
    }

    if (line.startsWith("# ")) {
      output.push(renderHeading(line.slice(2), 1));
      i++;
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      output.push(renderListItem(renderLine(line.slice(2))));
      i++;
      continue;
    }

    if (line.match(/^\d+\.\s/)) {
      const text = line.replace(/^\d+\.\s/, "");
      output.push(chalk.dim("  ") + chalk.dim(line.match(/^\d+/)![0] + ".") + " " + renderLine(text));
      i++;
      continue;
    }

    if (line.trim() === "---" || line.trim() === "***") {
      output.push(chalk.dim("  " + "─".repeat(54)));
      i++;
      continue;
    }

    output.push(renderLine(line));
    i++;
  }

  return output.join("\n");
}
