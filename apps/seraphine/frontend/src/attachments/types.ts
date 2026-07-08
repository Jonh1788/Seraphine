export interface AttachmentRef {
  id: string;
  kind: 'pdf' | 'image';
  mime: string;
  filename: string;
  size: number;
}
