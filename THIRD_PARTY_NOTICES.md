# Third-party notices

## Oh My Pi (OMP)

This project interoperates with a separately installed copy of
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). It is not affiliated
with, endorsed by, or an official component of Oh My Pi.

Oh My Pi is distributed under the MIT License:

> Copyright (c) 2025 Mario Zechner
> Copyright (c) 2025-2026 Can Bölük
> Copyright (c) 2026 Stencil Labs, Inc.

The complete upstream license is available at
https://github.com/can1357/oh-my-pi/blob/main/LICENSE.

The current MVP invokes the installed `omp` executable through its public CLI
and does not incorporate upstream source code. If upstream source is copied in
the future, its copyright and permission notice must accompany the copied or
substantial portions.

The stand-alone Docker image bundles the official OMP v18.3.2 Linux binary.
Its full MIT license and published third-party notices from the pinned upstream
commit are included in `licenses/OMP-LICENSE` and
`licenses/OMP-THIRD-PARTY-NOTICES.txt` inside this repository and image.
