"""
凍結用啟動器：以獨立執行檔啟動 pymobiledevice3 的 tunneld 服務。
等同於執行 `pymobiledevice3 remote tunneld`，但不需系統有 Python。
給 PyInstaller 凍結成 helper-bin/tunneld(.exe)。
"""
import sys


def main() -> None:
    # 沿用呼叫端傳入的額外參數（保留彈性）
    sys.argv = ["pymobiledevice3", "remote", "tunneld", *sys.argv[1:]]
    # pymobiledevice3 的 CLI 進入點是 __main__:main（不同版本若改名，退回 cli）
    import pymobiledevice3.__main__ as entry
    fn = getattr(entry, "main", None) or getattr(entry, "cli", None)
    if fn is None:
        raise SystemExit("找不到 pymobiledevice3 的 CLI 進入點")
    fn()


if __name__ == "__main__":
    main()