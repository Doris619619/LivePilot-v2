/** 浏览器可见的上传状态，仅包含文件名及确认字节，不暴露 B 的路径。 */
export type UploadStatus = {
  id: string; instanceId: string; kind: "videos" | "music"; filename: string;
  size: number; received: number; chunkSize: number; fingerprint: string;
  status: "uploading" | "verifying" | "complete"; expiresAt: number;
  publishedName?: string; error?: string;
};
