/**
 * Send one plain-text Gmail message as the authenticated user.
 * The model cannot choose the sender. There is no CC, BCC, HTML, or attachment path.
 */
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { google } from "googleapis";
import { getAuthClient, mapGoogleError, noWriteRetry } from "./auth.js";
import { ToolFailure, validateEmailInput, type SendEmailInput } from "./validation.js";

export interface EmailSuccess {
  success: true;
  message: "Email sent successfully";
  messageId: string;
  threadId?: string;
}

/**
 * Build a UTF-8 text/plain MIME message and return the base64url string
 * Gmail expects in users.messages.send requestBody.raw.
 * From is omitted on purpose: Gmail sets it to the authenticated mailbox.
 */
export async function buildRawMime(input: SendEmailInput): Promise<string> {
  const validated = validateEmailInput(input);
  const composer = new MailComposer({
    to: validated.to,
    subject: validated.subject,
    text: validated.body,
    textEncoding: "quoted-printable",
  });
  const message = await composer.compile().build();
  return message.toString("base64url");
}

export interface GmailSendClient {
  users: {
    messages: {
      send: (
        args: { userId: string; requestBody: { raw: string } },
        options?: { retry?: boolean },
      ) => Promise<{ data: { id?: string | null; threadId?: string | null } }>;
    };
  };
}

/** Validate, authorize, and send. Throws ToolFailure instead of reporting success. */
export async function sendPlainTextEmail(
  input: SendEmailInput,
  deps?: { gmail?: GmailSendClient },
): Promise<EmailSuccess> {
  validateEmailInput(input);
  const raw = await buildRawMime(input);
  const gmail = deps?.gmail ?? (await realGmailClient());

  try {
    const response = await gmail.users.messages.send(
      {
        userId: "me",
        requestBody: { raw },
      },
      noWriteRetry,
    );
    const messageId = response.data.id;
    if (!messageId) {
      throw new ToolFailure(
        "GMAIL_API_ERROR",
        "Gmail accepted the request but did not return a message id. Check Sent mail before trying again, so you do not send a duplicate.",
      );
    }
    return {
      success: true,
      message: "Email sent successfully",
      messageId,
      ...(response.data.threadId ? { threadId: response.data.threadId } : {}),
    };
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    throw mapGoogleError(err, "gmail");
  }
}

async function realGmailClient(): Promise<GmailSendClient> {
  const auth = await getAuthClient();
  return google.gmail({ version: "v1", auth }) as unknown as GmailSendClient;
}
