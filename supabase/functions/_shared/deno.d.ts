// Ambient Deno globals for VS Code TypeScript IntelliSense.
// The Deno runtime provides these natively; this file only exists for the linter.
declare namespace Deno {
  function serve(
    handler: (req: Request) => Response | Promise<Response>
  ): void;

  const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    toObject(): Record<string, string>;
  };
}
