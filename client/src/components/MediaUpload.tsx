import { useRef, useState, type DragEvent } from "react";
import { Icon } from "./Icons";
import { Button } from "./ui";
import "../styles/media.css";

// Upload an image or video from this computer. The file is stored by our server and sent to the platforms
// directly when the post is published, so it doesn't need to be on a public website.

export interface UploadedMedia {
  id: number;
  kind: "image" | "video";
  name: string;
  size?: number;
  /** The type the server found in the file itself (not from its name). */
  mime?: string | null;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
const IMAGE_MAX = 10 * 1024 * 1024;
const VIDEO_MAX = 100 * 1024 * 1024;
export const ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES].join(",");

export const mediaSrc = (id: number) => `/api/media/${id}`;
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Checks type and size before uploading, with the same limits as the server. */
export function fileProblem(file: File): string | null {
  const image = IMAGE_TYPES.includes(file.type);
  const video = VIDEO_TYPES.includes(file.type);
  if (!image && !video) return "Use a JPG, PNG or GIF image, or an MP4 or MOV video.";
  if (image && file.size > IMAGE_MAX) return `This image is ${mb(file.size)}. Images can be up to 10 MB.`;
  if (video && file.size > VIDEO_MAX) return `This video is ${mb(file.size)}. Videos can be up to 100 MB.`;
  return null;
}

/** Uploads with progress (0-100). The server identifies the file from its content, not its name. */
export function uploadMedia(file: File, onProgress?: (pct: number) => void): Promise<UploadedMedia> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: { media?: { id: number; kind: "image" | "video"; mime?: string; original_name: string; size_bytes: number }; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 401) window.dispatchEvent(new Event("session-expired"));
      if (xhr.status >= 200 && xhr.status < 300 && data.media) {
        resolve({ id: data.media.id, kind: data.media.kind, name: data.media.original_name, size: Number(data.media.size_bytes), mime: data.media.mime ?? null });
      } else {
        reject(new Error(data.error ?? (xhr.status === 413 ? "The file is too big." : `Upload failed (${xhr.status}).`)));
      }
    };
    xhr.onerror = () => reject(new Error("Can't reach the server. Check that it's running."));
    xhr.send(file);
  });
}

/** Shows an uploaded file. */
export function MediaPreview({ media, className = "" }: { media: Pick<UploadedMedia, "id" | "kind">; className?: string }) {
  return media.kind === "video" ? (
    <video className={`media-prev ${className}`} src={mediaSrc(media.id)} controls preload="metadata" />
  ) : (
    <img className={`media-prev ${className}`} src={mediaSrc(media.id)} alt="" />
  );
}

/** Upload button + drop zone, or the uploaded file with Replace / Remove. */
export function MediaUpload({ value, onChange, disabled, label = "Image or video" }: { value: UploadedMedia | null; onChange: (m: UploadedMedia | null) => void; disabled?: boolean; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function take(file: File | undefined) {
    if (!file || disabled) return;
    const problem = fileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPct(0);
    try {
      onChange(await uploadMedia(file, setPct));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPct(null);
      if (input.current) input.current.value = "";
    }
  }
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(e.dataTransfer.files?.[0]);
  };

  const picker = (
    <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void take(e.target.files?.[0])} aria-label={`Upload ${label.toLowerCase()}`} />
  );

  if (value)
    return (
      <div className="media-up has">
        <span className="lab-sm">{label}</span>
        <div className="media-card">
          <MediaPreview media={value} />
          <div className="media-meta">
            <Icon name={value.kind === "video" ? "send" : "eye"} />
            <span className="grow" title={value.name}>
              {value.name}
              {value.size ? <em> · {mb(value.size)}</em> : null}
            </span>
            {!disabled && (
              <>
                <Button size="sm" variant="quiet" loading={pct !== null} onClick={() => input.current?.click()}>
                  Replace
                </Button>
                <Button size="sm" variant="quiet" icon="trash" onClick={() => onChange(null)}>
                  Remove
                </Button>
              </>
            )}
          </div>
          {pct !== null && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
        </div>
        {error && <span className="media-err">{error}</span>}
        {picker}
      </div>
    );

  return (
    <div className="media-up">
      <span className="lab-sm">{label}</span>
      <div
        className={`media-drop ${over ? "over" : ""} ${disabled ? "off" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        {pct !== null ? (
          <div className="grow">
            <b>Uploading… {pct}%</b>
            <div className="bar">
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <>
            <span className="media-ico">
              <Icon name="download" />
            </span>
            <div className="grow">
              <b>Drag a file here, or</b>{" "}
              <button type="button" className="linkish" disabled={disabled} onClick={() => input.current?.click()}>
                choose one from your computer
              </button>
              <span className="media-hint">JPG, PNG or GIF up to 10 MB · MP4 or MOV up to 100 MB. It's sent with the post to each platform.</span>
            </div>
          </>
        )}
      </div>
      {error && <span className="media-err">{error}</span>}
      {picker}
    </div>
  );
}
