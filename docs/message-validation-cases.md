# message validation cases

Message validation cases: reject missing and non-string message bodies, whitespace-only text, and values beyond the configured length limit. Verify rejected messages are not broadcast. Confirm accepted messages preserve ordinary Unicode and emoji. Ensure server-derived sender identity cannot be overridden by client fields. Keep tests isolated from public rooms and avoid logging complete message contents.
