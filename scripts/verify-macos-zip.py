import os
import stat
import sys
import zipfile


def source_symlinks(app_dir: str, root_name: str) -> dict[str, str]:
    result = {}
    for current, dirs, files in os.walk(app_dir):
        for name in list(dirs) + list(files):
            full_path = os.path.join(current, name)
            if not os.path.islink(full_path):
                continue
            relative = os.path.relpath(full_path, app_dir).replace("\\", "/")
            result[f"{root_name}/{relative}"] = os.readlink(full_path).replace("\\", "/")
        dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(current, name))]
    return result


def main() -> None:
    app_dir, zip_path = sys.argv[1], sys.argv[2]
    app_dir = os.path.abspath(app_dir)
    root_name = os.path.basename(app_dir)
    expected = source_symlinks(app_dir, root_name)

    with zipfile.ZipFile(zip_path) as archive:
        names = set(archive.namelist())
        errors = []
        for archive_name, expected_target in expected.items():
            info = archive.getinfo(archive_name) if archive_name in names else None
            if info is None:
                errors.append(f"missing symlink: {archive_name}")
                continue
            mode = (info.external_attr >> 16) & 0xFFFF
            if not stat.S_ISLNK(mode):
                errors.append(f"not a symlink: {archive_name}")
                continue
            actual_target = archive.read(info).decode("utf-8")
            if actual_target != expected_target:
                errors.append(
                    f"target mismatch: {archive_name} expected={expected_target!r} actual={actual_target!r}"
                )

        main_executable = f"{root_name}/Contents/MacOS/SignalKVM"
        if main_executable not in names:
            errors.append(f"missing executable: {main_executable}")
        else:
            executable_mode = (archive.getinfo(main_executable).external_attr >> 16) & 0o777
            if executable_mode != 0o755:
                errors.append(f"bad executable mode: {oct(executable_mode)}")

        code_resources = f"{root_name}/Contents/_CodeSignature/CodeResources"
        if code_resources not in names:
            errors.append(f"missing code signature: {code_resources}")

    if errors:
        raise SystemExit("\n".join(errors))

    print(f"Verified {len(expected)} symlinks, executable mode, and code signature resources")


if __name__ == "__main__":
    main()
