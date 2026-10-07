const decoder = new TextDecoder();

/** A value read from, or written to, the store. */
export class Document {
  constructor(
    readonly key: string,
    readonly bytes: Uint8Array,
    /** The commit that wrote this value, when known. */
    readonly commit: string | null = null,
    /** MIME type Artifacts inferred from the key's extension, when read back. */
    readonly type = "",
  ) {}

  text(): string {
    return decoder.decode(this.bytes);
  }

  inspect(): string {
    return `#<ChangeAgent::Document key="${this.key}">`;
  }
}
