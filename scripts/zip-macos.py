import os
import stat
import sys
import zipfile


def file_mode(path: str) -> int:
    normalized = path.replace("\\", "/")
    executable = (
        "Contents/MacOS/" in normalized
        or "Contents/Frameworks/" in normalized
        or path.endswith(".dylib")
        or os.path.basename(path) == "m1ddc"
    )
    return 0o755 if executable else 0o644


def make_info(
    archive_name: str,
    mode: int,
    *,
    is_dir: bool = False,
    is_symlink: bool = False,
    compress: bool = True,
) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(archive_name)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    info.external_attr = mode << 16
    if is_dir:
        info.external_attr |= 0x10
    return info


def main() -> None:
    app_dir, output_zip = sys.argv[1], sys.argv[2]
    app_dir = os.path.abspath(app_dir)
    root_name = os.path.basename(app_dir)

    with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for current, dirs, files in os.walk(app_dir):
            relative_dir = os.path.relpath(current, app_dir)
            archive_dir = root_name if relative_dir == "." else os.path.join(root_name, relative_dir)
            archive_dir = archive_dir.replace("\\", "/")
            info = make_info(
                archive_dir + "/",
                stat.S_IFDIR | 0o755,
                is_dir=True,
                compress=False,
            )
            archive.writestr(info, b"")

            symlink_dirs = []
            for name in dirs:
                full_path = os.path.join(current, name)
                if not os.path.islink(full_path):
                    continue
                symlink_dirs.append(name)
                relative_link = os.path.relpath(full_path, app_dir)
                archive_name = os.path.join(root_name, relative_link).replace("\\", "/")
                info = make_info(
                    archive_name,
                    stat.S_IFLNK | 0o777,
                    is_symlink=True,
                    compress=False,
                )
                target = os.readlink(full_path).replace("\\", "/")
                archive.writestr(info, target.encode("utf-8"))
            dirs[:] = [name for name in dirs if name not in symlink_dirs]

            for name in files:
                full_path = os.path.join(current, name)
                relative_file = os.path.relpath(full_path, app_dir)
                archive_name = os.path.join(root_name, relative_file).replace("\\", "/")
                if os.path.islink(full_path):
                    info = make_info(
                        archive_name,
                        stat.S_IFLNK | 0o777,
                        is_symlink=True,
                        compress=False,
                    )
                    payload = os.readlink(full_path).replace("\\", "/").encode("utf-8")
                else:
                    with open(full_path, "rb") as source:
                        payload = source.read()
                    info = make_info(archive_name, stat.S_IFREG | file_mode(archive_name))
                archive.writestr(info, payload)

    print(output_zip)


if __name__ == "__main__":
    main()
