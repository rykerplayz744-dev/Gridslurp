GRIDSLURP Death Effects Folder (/src/death-effects/)

Drop any transparent animated .gif or still .png files into this folder before building/deploying to Vercel.
Vite automatically discovers and bundles all *.gif and *.png files placed here (including subfolders).

How it renders on death:
- Covers the 3x3 pixel area centered on the dead snake's head:
  from (headX - 1, headY + 1) [down 1, left 1] to (headX + 1, headY - 1) [up 1, right 1].
- Animated transparent GIFs restart from frame 0 on every death.
- Still transparent PNGs are also supported alongside GIFs.
