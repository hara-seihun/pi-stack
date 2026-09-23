"use strict";

(function installMarkdownCompatibility(global) {
  function normalizeLatexDelimiters(source) {
    const value = String(source || "");
    let output = "";
    let fenced = false;
    let fenceCharacter = "";
    let fenceLength = 0;
    let inlineCodeLength = 0;
    let lineStart = true;

    for (let index = 0; index < value.length;) {
      if (lineStart) {
        let marker = index;
        while (marker < value.length && marker - index < 3 && value[marker] === " ") marker++;
        if (value[marker] === "`" || value[marker] === "~") {
          const character = value[marker];
          let end = marker;
          while (value[end] === character) end++;
          const length = end - marker;
          if ((!fenced && length >= 3) || (fenced && character === fenceCharacter && length >= fenceLength)) {
            output += value.slice(index, end);
            index = end;
            if (fenced) {
              fenced = false;
              fenceCharacter = "";
              fenceLength = 0;
            } else {
              fenced = true;
              fenceCharacter = character;
              fenceLength = length;
            }
            lineStart = false;
            continue;
          }
        }
      }

      const character = value[index];
      if (character === "\n") {
        output += character;
        index++;
        lineStart = true;
        continue;
      }
      if (fenced) {
        output += character;
        index++;
        lineStart = false;
        continue;
      }
      lineStart = false;

      if (character === "`") {
        let end = index;
        while (value[end] === "`") end++;
        const length = end - index;
        if (inlineCodeLength === 0) inlineCodeLength = length;
        else if (inlineCodeLength === length) inlineCodeLength = 0;
        output += value.slice(index, end);
        index = end;
        continue;
      }

      if (inlineCodeLength === 0 && character === "\\" && index + 1 < value.length) {
        const delimiter = value[index + 1];
        if (delimiter === "(" || delimiter === ")") {
          output += "$";
          index += 2;
          continue;
        }
        if (delimiter === "[" || delimiter === "]") {
          output += "$$";
          index += 2;
          continue;
        }
      }

      output += character;
      index++;
    }
    return output;
  }

  global.normalizeLatexDelimiters = normalizeLatexDelimiters;
})(globalThis);
