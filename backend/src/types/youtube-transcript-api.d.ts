declare module "youtube-transcript-api" {
  export interface TranscriptSegment {
    text: string;
    start: number;
    duration: number;
  }

  export class YoutubeTranscript {
    static fetchTranscript(videoIdOrUrl: string): Promise<TranscriptSegment[]>;
  }
}
