export interface SessionNotificationSink {
  sendSessionNotification(
    sessionId: string,
    message: string,
    displayMessage?: string,
  ): Promise<void>;
  sendConnectorNotification(message: string): Promise<void>;
}

export interface SessionNotificationOptions {
  sink?: SessionNotificationSink;
}
