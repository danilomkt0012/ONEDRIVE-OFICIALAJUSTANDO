{pkgs}: {
  deps = [
    pkgs.ffmpeg
    pkgs.util-linux
    pkgs.pixman
    pkgs.librsvg
    pkgs.giflib
    pkgs.libjpeg
    pkgs.pango
    pkgs.cairo
    pkgs.pkg-config
  ];
}
