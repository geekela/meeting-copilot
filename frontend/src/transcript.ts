/** Puts the transcript below anything already in the notes, never over it. */
export function appendTranscript(notes: string, transcript: string): string {
  return notes.trim() ? `${notes.trimEnd()}\n\n${transcript}` : transcript;
}
