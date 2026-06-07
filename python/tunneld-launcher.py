"""
凍結用啟動器：以獨立執行檔啟動 pymobiledevice3 的 tunneld 服務。
等同於執行 `pymobiledevice3 remote tunneld`，但不需系統有 Python。
給 PyInstaller 凍結成 helper-bin/tunneld(.exe)。
"""
import sys


def main() -> None:
    # 沿用呼叫端傳入的額外參數（保留彈性）
    sys.argv = ["pymobiledevice3", "remote", "tunneld", *sys.argv[1:]]
    try:
        import runpy
        runpy.run_module("pymobiledevice3", run_name="__main__", alter_sys=True)
    except SystemExit:
        raise
    except Exception:
        # 退而求其次：直接呼叫 CLI 進入點（不同版本位置可能不同）
        try:
            from pymobiledevice3.__main__ import cli
        except Exception:
            from pymobiledevice3.cli.cli import cli  # type: ignore
        cli()


if __name__ == "__main__":
    main()
