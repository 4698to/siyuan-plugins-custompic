from __future__ import annotations

import subprocess
from pathlib import Path


def compress_image_to_webp(file_path: Path) -> Path:
    """
    尝试使用 ffmpeg 将常见图片转为 webp（同目录同名 .webp）。
    - 成功：返回新文件路径，并尝试删除原文件
    - 失败/未安装 ffmpeg：返回原文件路径
    """
    try:
        src = Path(file_path).resolve()
        if not src.is_file():
            return file_path
        ext = src.suffix.lower()
        if ext not in {".gif", ".png", ".jpg", ".jpeg"}:
            return file_path

        dst = src.with_suffix(".webp")
        # png 优先走 lossless；其余用有损质量参数
        if ext == ".png":
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-vcodec",
                "libwebp",
                "-lossless",
                "1",
                str(dst),
            ]
        elif ext == ".gif":
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                # 尽量保留 GIF 每帧原始延时（避免被重采样为固定 FPS）
                "-fps_mode",
                "passthrough",
                "-vcodec",
                "libwebp",
                "-loop",
                "0",
                "-preset",
                "picture",
                "-an",
                "-vsync",
                "0",
                str(dst),
            ]
        else:
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-vcodec",
                "libwebp",
                "-q:v",
                "75",
                "-preset",
                "picture",
                str(dst),
            ]

        # 不抛到上层，避免影响上传成功流程
        subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        if dst.is_file() and dst.stat().st_size > 0:
            try:
                src.unlink(missing_ok=True)
            except Exception:
                pass
            return dst
        return file_path
    except Exception:
        return file_path

