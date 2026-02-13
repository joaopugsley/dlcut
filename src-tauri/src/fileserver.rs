//! Minimal local HTTP file server for video preview.
//!
//! WebView2 on Windows rejects Tauri's asset protocol for `<video>` elements,
//! and loading entire files into memory via blob URLs crashes on large files.
//! This module serves a single file over HTTP with range request support so
//! the video element can stream efficiently.

use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

pub struct FileServer {
    shutdown_tx: watch::Sender<bool>,
    port: u16,
}

impl FileServer {
    pub async fn start(file_path: PathBuf) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        tokio::spawn(Self::run(listener, file_path, shutdown_rx));

        Ok(Self { shutdown_tx, port })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/video", self.port)
    }

    pub fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    async fn run(
        listener: TcpListener,
        file_path: PathBuf,
        mut shutdown_rx: watch::Receiver<bool>,
    ) {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    if let Ok((stream, _)) = result {
                        let path = file_path.clone();
                        tokio::spawn(Self::handle_connection(stream, path));
                    }
                }
                _ = shutdown_rx.changed() => {
                    break;
                }
            }
        }
    }

    async fn handle_connection(mut stream: tokio::net::TcpStream, file_path: PathBuf) {
        let mut buf = vec![0u8; 4096];
        let n = match stream.read(&mut buf).await {
            Ok(0) => return,
            Ok(n) => n,
            Err(_) => return,
        };
        let request = String::from_utf8_lossy(&buf[..n]);

        let metadata = match tokio::fs::metadata(&file_path).await {
            Ok(m) => m,
            Err(_) => {
                let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(resp.as_bytes()).await;
                return;
            }
        };
        let file_size = metadata.len();

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let content_type = match ext.to_lowercase().as_str() {
            "mp4" | "m4v" => "video/mp4",
            "mkv" => "video/x-matroska",
            "avi" => "video/x-msvideo",
            "mov" => "video/quicktime",
            "webm" => "video/webm",
            "flv" => "video/x-flv",
            "wmv" => "video/x-ms-wmv",
            _ => "application/octet-stream",
        };

        // Parse Range header
        let range = request.lines().find_map(|line| {
            let lower = line.to_lowercase();
            if !lower.starts_with("range:") {
                return None;
            }
            let val = line.splitn(2, ':').nth(1)?.trim();
            let bytes_str = val.strip_prefix("bytes=")?;
            let mut parts = bytes_str.splitn(2, '-');
            let start: u64 = parts.next()?.parse().ok()?;
            let end: u64 = match parts.next() {
                Some(s) if !s.is_empty() => s.parse().ok()?,
                _ => file_size.saturating_sub(1),
            };
            Some((start, end.min(file_size.saturating_sub(1))))
        });

        let (status_line, start, length) = match range {
            Some((start, end)) => {
                let len = end - start + 1;
                let status = format!(
                    "HTTP/1.1 206 Partial Content\r\n\
                     Content-Range: bytes {}-{}/{}\r\n",
                    start, end, file_size
                );
                (status, start, len)
            }
            None => ("HTTP/1.1 200 OK\r\n".to_string(), 0, file_size),
        };

        let header = format!(
            "{}\
             Content-Type: {}\r\n\
             Content-Length: {}\r\n\
             Accept-Ranges: bytes\r\n\
             Connection: close\r\n\r\n",
            status_line, content_type, length
        );

        if stream.write_all(header.as_bytes()).await.is_err() {
            return;
        }

        // Check if this is a HEAD request — no body needed
        if request.starts_with("HEAD ") {
            return;
        }

        let mut file = match File::open(&file_path).await {
            Ok(f) => f,
            Err(_) => return,
        };

        if start > 0 {
            if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
                return;
            }
        }

        let mut remaining = length;
        let mut chunk = vec![0u8; 64 * 1024];
        while remaining > 0 {
            let to_read = (remaining as usize).min(chunk.len());
            match file.read(&mut chunk[..to_read]).await {
                Ok(0) => break,
                Ok(n) => {
                    if stream.write_all(&chunk[..n]).await.is_err() {
                        break;
                    }
                    remaining -= n as u64;
                }
                Err(_) => break,
            }
        }
    }
}
