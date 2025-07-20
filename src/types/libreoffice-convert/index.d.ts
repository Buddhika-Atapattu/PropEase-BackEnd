declare function convert(
  input: Buffer,
  extend: string,
  filter: any,
  callback: (err: Error | null, done: Buffer) => void
): void;

export = convert;