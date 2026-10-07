import { randomInt } from "node:crypto";

type Prime = {
  syllable: string;
  onset: string;
  vowel: string;
};

const primeRows = [
  ["ke", "k", "e"], ["ku", "k", "u"], ["ko", "k", "o"], ["kai", "k", "ai"], ["kei", "k", "ei"],
  ["la", "l", "a"], ["le", "l", "e"], ["lo", "l", "o"], ["lu", "l", "u"],
  ["na", "n", "a"], ["ne", "n", "e"], ["ni", "n", "i"], ["no", "n", "o"], ["nu", "n", "u"], ["nei", "n", "ei"], ["nai", "n", "ai"],
  ["be", "b", "e"], ["bi", "b", "i"], ["bu", "b", "u"], ["bai", "b", "ai"], ["bei", "b", "ei"],
  ["ma", "m", "a"], ["me", "m", "e"], ["mai", "m", "ai"], ["mei", "m", "ei"], ["mu", "m", "u"], ["mo", "m", "o"],
  ["sha", "sh", "a"], ["shi", "sh", "i"], ["sho", "sh", "o"], ["shai", "sh", "ai"],
  ["zhai", "zh", "ai"], ["zhu", "zh", "u"],
  ["si", "s", "i"], ["so", "s", "o"], ["su", "s", "u"], ["sei", "s", "ei"], ["sai", "s", "ai"], ["se", "s", "e"],
  ["ta", "t", "a"], ["tu", "t", "u"], ["ti", "t", "i"], ["te", "t", "e"], ["to", "t", "o"], ["tai", "t", "ai"],
  ["ra", "r", "a"], ["re", "r", "e"], ["ri", "r", "i"], ["rai", "r", "ai"], ["rei", "r", "ei"],
  ["ha", "h", "a"], ["he", "h", "e"], ["hai", "h", "ai"], ["hei", "h", "ei"], ["hu", "h", "u"], ["hi", "h", "i"], ["ho", "h", "o"],
] as const;

const primes: readonly Prime[] = primeRows.map(([syllable, onset, vowel]) => ({ syllable, onset, vowel }));
const backVowels = new Set(["u", "o"]);
const risingVowels = new Set(["ai", "ei"]);
const iEndingVowels = new Set(["i", "ai", "ei"]);

function adjacentIsLegal(left: Prime, right: Prime): boolean {
  if (left.onset === right.onset && left.onset !== "s") return true;
  if (backVowels.has(left.vowel) && (right.onset === "b" || right.onset === "t")) return false;
  if (left.vowel === "ei" && right.onset === "k") return false;
  if (left.vowel === "i" && right.vowel === "i") return false;
  if (iEndingVowels.has(left.vowel) && right.onset === "l") return false;
  if (risingVowels.has(left.vowel) && right.onset === "k" && risingVowels.has(right.vowel)) return false;
  if (backVowels.has(left.vowel) && right.onset === "k" && backVowels.has(right.vowel)) return false;
  return true;
}

function sequenceIsLegal(sequence: readonly Prime[]): boolean {
  return sequence.slice(1).every((right, index) => adjacentIsLegal(sequence[index]!, right));
}

function validSequenceCount(length: number): number {
  let counts = primes.map(() => 1);
  for (let position = 1; position < length; position += 1) {
    counts = primes.map((right) => counts.reduce(
      (total, count, index) => total + (adjacentIsLegal(primes[index]!, right) ? count : 0),
      0,
    ));
  }
  return counts.reduce((total, count) => total + count, 0);
}

const threePrimeCount = validSequenceCount(3);
const fourPrimeCount = validSequenceCount(4);

function randomSequence(length: number): Prime[] {
  while (true) {
    const candidate = Array.from({ length }, () => primes[randomInt(primes.length)]!);
    if (sequenceIsLegal(candidate)) return candidate;
  }
}

function romanize(sequence: readonly Prime[]): string {
  const repaired: Prime[] = [];
  for (const prime of sequence) {
    if (repaired.at(-1)?.onset === prime.onset && prime.onset !== "s") {
      repaired.push({ syllable: "sa", onset: "s", vowel: "a" });
    }
    repaired.push(prime);
  }

  const word = repaired.map((prime, index) => {
    if (index === 0 && prime.onset === "h") return prime.vowel;
    if (index > 0 && prime.onset === "s") return `z${prime.vowel}`;
    return prime.syllable;
  }).join("");
  return word[0]!.toUpperCase() + word.slice(1);
}

/** Agents carry a single Nebulani first name. */
export function getRandomName(): string {
  const length = randomInt(threePrimeCount + fourPrimeCount) < threePrimeCount ? 3 : 4;
  return romanize(randomSequence(length));
}
