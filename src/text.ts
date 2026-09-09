import { stripVTControlCharacters } from "node:util";

export function plain(text: string) {
  return Array.from(stripVTControlCharacters(text))
    .filter(
      (char) =>
        char === "\n" ||
        char === "\t" ||
        (char >= " " && !(char >= "\u007f" && char <= "\u009f")),
    )
    .join("");
}
