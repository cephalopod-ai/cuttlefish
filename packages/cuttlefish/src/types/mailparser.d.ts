declare module "mailparser" {
  export function simpleParser(input: Buffer | string): Promise<unknown>;
}
