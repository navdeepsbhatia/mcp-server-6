/**
 * Input checks and the error shape both tools return.
 * The Zod schemas are what the MCP host sees. The same rules run again inside each tool.
 */
import * as z from "zod/v4";

const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOCUMENT_ID = /^[a-zA-Z0-9_-]{25,}$/;
const DOCUMENT_URL = /\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/;

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 100_000;

export class ToolFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface ValidEmail {
  to: string;
  subject: string;
  body: string;
}

export interface AppendInput {
  documentId: string;
  content: string;
}

/** Failure payload returned to the MCP client. Never includes tokens or secrets. */
export function toFailurePayload(err: unknown): {
  success: false;
  error: string;
  message: string;
} {
  if (err instanceof ToolFailure) {
    return { success: false, error: err.code, message: err.message };
  }
  return {
    success: false,
    error: "UNEXPECTED_ERROR",
    message: "The tool failed before completing. Check Google authorization and try again.",
  };
}

/**
 * Accept exactly one email address.
 * Newlines and extra addresses are rejected so they cannot become extra headers.
 */
export function validateEmailInput(input: SendEmailInput): ValidEmail {
  const to = input.to.trim();
  if (to.length === 0 || /[\r\n]/.test(input.to) || /[\s,;<>]/.test(to) || !EMAIL_ADDRESS.test(to)) {
    throw new ToolFailure(
      "INVALID_RECIPIENT",
      "Recipient must be one email address, with no display name, spaces, commas, or line breaks.",
    );
  }

  if (/[\r\n]/.test(input.subject)) {
    throw new ToolFailure(
      "INVALID_SUBJECT",
      "Subject must be a single line. Line breaks are not allowed.",
    );
  }
  const subject = input.subject.trim();
  if (subject.length === 0) {
    throw new ToolFailure("INVALID_SUBJECT", "Subject is required.");
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new ToolFailure(
      "INVALID_SUBJECT",
      `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.`,
    );
  }

  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new ToolFailure("INVALID_BODY", "Body is required and must be nonempty plain text.");
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    throw new ToolFailure("INVALID_BODY", "Body is too long. Send a shorter message.");
  }

  // Keep the body exactly as entered so user line breaks survive.
  return { to, subject, body: input.body };
}

/** Schema registered on send_email. Rejects header injection before any Gmail call. */
export const sendEmailSchema = z
  .object({
    to: z.string().describe("One recipient email address. No display name, commas, or line breaks."),
    subject: z.string().describe("Email subject. One nonempty line, 200 characters or fewer."),
    body: z.string().describe("Plain-text body. Line breaks the user entered are preserved."),
  })
  .superRefine((value, ctx) => {
    try {
      validateEmailInput(value);
    } catch (err) {
      const failure = err instanceof ToolFailure ? err : new ToolFailure("INVALID_RECIPIENT", "Invalid email input.");
      const path =
        failure.code === "INVALID_SUBJECT" ? ["subject"] : failure.code === "INVALID_BODY" ? ["body"] : ["to"];
      ctx.addIssue({ code: "custom", message: failure.message, path });
    }
  });

/**
 * Accept a raw document ID or a Docs URL and return only the ID.
 * Example: https://docs.google.com/document/d/DOCUMENT_ID/edit
 */
export function extractDocumentId(document: string): string {
  const trimmed = document.trim();
  if (trimmed.length === 0) {
    throw new ToolFailure("INVALID_DOCUMENT", "A Google Doc ID or URL is required.");
  }
  if (/[\r\n]/.test(document)) {
    throw new ToolFailure("INVALID_DOCUMENT", "The document ID or URL must be a single line.");
  }

  const looksLikeUrl = /^https?:\/\//i.test(trimmed) || trimmed.includes("docs.google.com");
  if (looksLikeUrl) {
    const match = trimmed.match(DOCUMENT_URL);
    const id = match?.[1];
    if (!id || !DOCUMENT_ID.test(id)) {
      throw new ToolFailure(
        "INVALID_DOCUMENT",
        "That URL is not a usable Google Docs link. Paste a link like https://docs.google.com/document/d/DOCUMENT_ID/edit or the document ID itself.",
      );
    }
    return id;
  }

  if (!DOCUMENT_ID.test(trimmed)) {
    throw new ToolFailure(
      "INVALID_DOCUMENT",
      "That document ID does not look valid. Paste the ID from the Docs URL or the full edit link.",
    );
  }
  return trimmed;
}

/** Reject empty notes. The original text, including line breaks, is what gets appended. */
export function validateAppendContent(content: string): string {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ToolFailure("INVALID_CONTENT", "Content is required and must be nonempty plain text.");
  }
  if (content.length > MAX_BODY_LENGTH) {
    throw new ToolFailure("INVALID_CONTENT", "Content is too long. Append a shorter note.");
  }
  return content;
}

/** Schema registered on append_to_google_doc. */
export const appendDocSchema = z
  .object({
    documentId: z
      .string()
      .describe("Google Doc ID or a URL like https://docs.google.com/document/d/DOCUMENT_ID/edit."),
    content: z.string().describe("Plain text to append. Markdown characters such as ### are stored as text."),
  })
  .superRefine((value, ctx) => {
    try {
      extractDocumentId(value.documentId);
    } catch (err) {
      const message = err instanceof ToolFailure ? err.message : "Invalid document.";
      ctx.addIssue({ code: "custom", message, path: ["documentId"] });
    }
    try {
      validateAppendContent(value.content);
    } catch (err) {
      const message = err instanceof ToolFailure ? err.message : "Invalid content.";
      ctx.addIssue({ code: "custom", message, path: ["content"] });
    }
  });
