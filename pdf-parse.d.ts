declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseOptions { pagerender?: (pageData: any) => Promise<string> | string; max?: number; }
  function pdfParse(data: Buffer | Uint8Array, options?: PdfParseOptions): Promise<{ text: string; numpages: number }>;
  export default pdfParse;
}
