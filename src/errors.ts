import { Cause, Effect, Schema } from "effect";
import { ActionError } from "./actions/selection";
import { ConfigError } from "./config";
import { GitHubError } from "./services/github";
import { Herdr, HerdrError } from "./services/herdr";
import { ProcessError } from "./services/process";
import { plain } from "./text";

export const reportError = Effect.fn("Errors.reportError")(function* (
  cause: Cause.Cause<unknown>,
  title = "Workflow Watch failed",
) {
  if (Cause.hasInterruptsOnly(cause)) return "";
  const error = Cause.squash(cause);
  const message = plain(
    error instanceof ConfigError || error instanceof ActionError
      ? error.message
      : error instanceof GitHubError
        ? "Could not read GitHub Actions. Check your connection and gh authentication, then try again."
        : error instanceof HerdrError
          ? "Could not complete the Herdr request. Check that the session is running and try again."
          : error instanceof ProcessError
            ? `Could not run ${error.command}. Check the plugin logs for details.`
            : "Workflow Watch could not complete this operation. Check the plugin logs for details.",
  )
    .replace(/\s+/g, " ")
    .slice(0, 500);
  yield* Effect.logError(title, cause);
  const socket = process.env.HERDR_SOCKET_PATH;
  if (socket) {
    yield* Herdr.request(
      socket,
      5_000,
      "notification.show",
      {
        title,
        body: message,
      },
      Schema.Unknown,
    ).pipe(
      Effect.catchCause((notificationCause) =>
        Effect.logWarning(
          "Could not deliver the Herdr error notification",
          notificationCause,
        ),
      ),
    );
  }
  return message;
});
