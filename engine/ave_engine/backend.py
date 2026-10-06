"""Array backend for the compositor hot paths: torch on the NVIDIA card when available, numpy otherwise.

Frames are float32 arrays shaped (height, width, channels) with values 0..1, in both backends, so
compositing and effect code is written once with ordinary operators (+ - * / ** slicing .clip) and the
few helpers below. Both backends use the same sampling conventions (pixel centres at +0.5, bilinear
interpolation, transparent outside the source), so they draw the same picture.

Set AVE_BACKEND=numpy to force the CPU path.
"""
from __future__ import annotations

import math
import os

import numpy as np

try:  # OpenCV speeds up the CPU path; it is optional.
    import cv2  # type: ignore

    cv2.setNumThreads(max(1, (os.cpu_count() or 2)))
except Exception:  # noqa: BLE001
    cv2 = None

LUMA = (0.2126, 0.7152, 0.0722)


def torch_status() -> dict:
    """Version of torch, whether CUDA works, and the card's name (never raises)."""
    try:
        import torch  # type: ignore
    except Exception:  # noqa: BLE001
        return {'torch': None, 'cuda': False, 'gpu': None}
    cuda = False
    gpu = None
    try:
        cuda = bool(torch.cuda.is_available())
        if cuda:
            gpu = torch.cuda.get_device_name(0)
            # A card the installed torch build does not support reports available but fails on use.
            (torch.ones(8, device='cuda') * 2).sum().item()
    except Exception:  # noqa: BLE001
        cuda = False
    return {'torch': getattr(torch, '__version__', None), 'cuda': cuda, 'gpu': gpu}


class NumpyBackend:
    name = 'numpy'

    def upload(self, a: np.ndarray):
        return np.ascontiguousarray(a, dtype=np.float32)

    def download(self, x) -> np.ndarray:
        return np.asarray(x, dtype=np.float32)

    def from_uint8(self, a: np.ndarray):
        return a.astype(np.float32) * (1.0 / 255.0)

    def to_uint8(self, x) -> np.ndarray:
        y = np.clip(x, 0.0, 1.0) * 255.0 + 0.5
        return y.astype(np.uint8)

    def zeros(self, h: int, w: int, c: int):
        return np.zeros((h, w, c), dtype=np.float32)

    def full(self, h: int, w: int, color):
        c = np.asarray(color, dtype=np.float32)
        return np.broadcast_to(c, (h, w, len(c))).copy()

    def copy(self, x):
        return x.copy()

    def stack(self, xs, axis=-1):
        return np.stack(xs, axis=axis)

    def concat(self, xs, axis=-1):
        return np.concatenate(xs, axis=axis)

    def where(self, cond, a, b):
        return np.where(cond, a, b)

    def luma(self, x):
        return x[..., 0:1] * LUMA[0] + x[..., 1:2] * LUMA[1] + x[..., 2:3] * LUMA[2]

    def maximum(self, a, b):
        return np.maximum(a, b)

    def minimum(self, a, b):
        return np.minimum(a, b)

    def grid(self, h: int, w: int):
        """Pixel-centre coordinates as fractions of width/height: (y, x) each shaped (h, w, 1)."""
        ys = ((np.arange(h, dtype=np.float32) + 0.5) / h)[:, None, None]
        xs = ((np.arange(w, dtype=np.float32) + 0.5) / w)[None, :, None]
        return np.broadcast_to(ys, (h, w, 1)), np.broadcast_to(xs, (h, w, 1))

    def resize(self, x, w: int, h: int):
        """Bilinear resize, antialiased when shrinking (matches torch's antialias=True)."""
        x = np.asarray(x, dtype=np.float32)
        if x.shape[1] == w and x.shape[0] == h:
            return x
        if cv2 is not None:
            shrink = w < x.shape[1] or h < x.shape[0]
            out = cv2.resize(x, (w, h), interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR)
            return out.reshape(h, w, -1)
        from PIL import Image

        chans = [np.asarray(Image.fromarray(np.ascontiguousarray(x[..., c]), mode='F').resize((w, h), Image.BILINEAR))
                 for c in range(x.shape[2])]
        return np.stack(chans, axis=-1).astype(np.float32)

    def blur(self, x, sigma: float):
        if sigma <= 0.05:
            return x
        if cv2 is not None:
            k = int(math.ceil(sigma * 3)) * 2 + 1
            return cv2.GaussianBlur(np.ascontiguousarray(x), (k, k), sigma, sigma, borderType=cv2.BORDER_REFLECT).reshape(x.shape)
        from scipy.ndimage import gaussian_filter

        return gaussian_filter(x, sigma=(sigma, sigma, 0), mode='reflect', truncate=3.0).astype(np.float32)

    def shift_x(self, x, px: float):
        """Shift horizontally by a fractional number of pixels (edge pixels repeat)."""
        w = x.shape[1]
        xs = np.arange(w, dtype=np.float32) - px
        x0 = np.floor(xs)
        f = (xs - x0)[None, :, None]
        i0 = np.clip(x0.astype(np.int64), 0, w - 1)
        i1 = np.clip(i0 + 1, 0, w - 1)
        return x[:, i0] * (1 - f) + x[:, i1] * f

    def warp(self, src, m_inv: np.ndarray, out_w: int, out_h: int):
        """Sample `src` (h, w, 4, premultiplied) for an out_h x out_w region. m_inv maps an output pixel
        index (x, y) to a source pixel index (u, v): [u, v] = m_inv @ [x, y, 1]. Outside is transparent."""
        src = np.asarray(src, dtype=np.float32)
        h, w, c = src.shape
        padded = np.zeros((h + 2, w + 2, c), dtype=np.float32)
        padded[1:-1, 1:-1] = src
        m = m_inv.astype(np.float64).copy()
        m[:, 2] += 1.0  # padding offset
        if cv2 is not None and c <= 4:
            out = cv2.warpAffine(padded, m, (out_w, out_h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
            return out.reshape(out_h, out_w, c)
        xs = np.arange(out_w, dtype=np.float32)[None, :]
        ys = np.arange(out_h, dtype=np.float32)[:, None]
        u = (m[0, 0] * xs + m[0, 1] * ys + m[0, 2]).astype(np.float32)
        v = (m[1, 0] * xs + m[1, 1] * ys + m[1, 2]).astype(np.float32)
        inside = (u > -1) & (u < w + 2) & (v > -1) & (v < h + 2)
        u0 = np.floor(u)
        v0 = np.floor(v)
        fu = (u - u0)[..., None]
        fv = (v - v0)[..., None]
        pw = w + 2
        i0 = np.clip(u0, 0, w + 1).astype(np.intp)
        j0 = np.clip(v0, 0, h + 1).astype(np.intp)
        i1 = np.minimum(i0 + 1, w + 1)
        j1 = np.minimum(j0 + 1, h + 1)
        flat = padded.reshape(-1, c)
        top = flat[j0 * pw + i0] * (1 - fu) + flat[j0 * pw + i1] * fu
        bot = flat[j1 * pw + i0] * (1 - fu) + flat[j1 * pw + i1] * fu
        out = top * (1 - fv) + bot * fv
        out[~inside] = 0
        return out.astype(np.float32, copy=False)

    def to_yuv420p(self, x) -> bytes | None:
        return None  # ffmpeg converts rgb24 on the CPU path


class TorchBackend:
    name = 'torch'

    def __init__(self, device: str = 'cuda'):
        import torch  # type: ignore

        self.torch = torch
        self.F = torch.nn.functional
        self.device = torch.device(device)
        torch.backends.cudnn.benchmark = True

    def upload(self, a: np.ndarray):
        return self.torch.from_numpy(np.ascontiguousarray(a, dtype=np.float32)).to(self.device, non_blocking=True)

    def download(self, x) -> np.ndarray:
        return x.detach().float().cpu().numpy()

    def from_uint8(self, a: np.ndarray):
        t = self.torch.from_numpy(np.ascontiguousarray(a)).to(self.device, non_blocking=True)
        return t.float().mul_(1.0 / 255.0)

    def to_uint8(self, x) -> np.ndarray:
        return (x.clamp(0, 1) * 255.0 + 0.5).to(self.torch.uint8).cpu().numpy()

    def zeros(self, h, w, c):
        return self.torch.zeros((h, w, c), dtype=self.torch.float32, device=self.device)

    def full(self, h, w, color):
        c = self.torch.tensor(list(color), dtype=self.torch.float32, device=self.device)
        return c.expand(h, w, len(color)).clone()

    def copy(self, x):
        return x.clone()

    def stack(self, xs, axis=-1):
        return self.torch.stack(list(xs), dim=axis)

    def concat(self, xs, axis=-1):
        return self.torch.cat(list(xs), dim=axis)

    def where(self, cond, a, b):
        t = self.torch
        a = a if t.is_tensor(a) else t.tensor(a, dtype=t.float32, device=self.device)
        b = b if t.is_tensor(b) else t.tensor(b, dtype=t.float32, device=self.device)
        return t.where(cond, a, b)

    def luma(self, x):
        return x[..., 0:1] * LUMA[0] + x[..., 1:2] * LUMA[1] + x[..., 2:3] * LUMA[2]

    def maximum(self, a, b):
        t = self.torch
        return t.maximum(a, b if t.is_tensor(b) else t.tensor(b, dtype=t.float32, device=self.device))

    def minimum(self, a, b):
        t = self.torch
        return t.minimum(a, b if t.is_tensor(b) else t.tensor(b, dtype=t.float32, device=self.device))

    def grid(self, h, w):
        t = self.torch
        ys = ((t.arange(h, dtype=t.float32, device=self.device) + 0.5) / h)[:, None, None].expand(h, w, 1)
        xs = ((t.arange(w, dtype=t.float32, device=self.device) + 0.5) / w)[None, :, None].expand(h, w, 1)
        return ys, xs

    def _nchw(self, x):
        return x.permute(2, 0, 1).unsqueeze(0)

    def _hwc(self, x):
        return x.squeeze(0).permute(1, 2, 0).contiguous()

    def resize(self, x, w, h):
        if x.shape[1] == w and x.shape[0] == h:
            return x
        shrink = w < x.shape[1] or h < x.shape[0]
        y = self.F.interpolate(self._nchw(x), size=(h, w), mode='bilinear', align_corners=False, antialias=shrink)
        return self._hwc(y)

    def blur(self, x, sigma):
        if sigma <= 0.05:
            return x
        t = self.torch
        r = int(math.ceil(sigma * 3))
        k = t.arange(-r, r + 1, dtype=t.float32, device=self.device)
        k = t.exp(-(k * k) / (2 * sigma * sigma))
        k = k / k.sum()
        c = x.shape[2]
        y = self._nchw(x)
        y = self.F.pad(y, (r, r, 0, 0), mode='reflect')
        y = self.F.conv2d(y, k.view(1, 1, 1, -1).expand(c, 1, 1, -1), groups=c)
        y = self.F.pad(y, (0, 0, r, r), mode='reflect')
        y = self.F.conv2d(y, k.view(1, 1, -1, 1).expand(c, 1, -1, 1), groups=c)
        return self._hwc(y)

    def shift_x(self, x, px):
        t = self.torch
        w = x.shape[1]
        xs = t.arange(w, dtype=t.float32, device=self.device) - px
        x0 = t.floor(xs)
        f = (xs - x0)[None, :, None]
        i0 = x0.long().clamp(0, w - 1)
        i1 = (i0 + 1).clamp(0, w - 1)
        return x[:, i0] * (1 - f) + x[:, i1] * f

    def warp(self, src, m_inv, out_w, out_h):
        t = self.torch
        h, w, c = src.shape
        m = t.tensor(m_inv, dtype=t.float32, device=self.device)
        ys = t.arange(out_h, dtype=t.float32, device=self.device)[:, None].expand(out_h, out_w)
        xs = t.arange(out_w, dtype=t.float32, device=self.device)[None, :].expand(out_h, out_w)
        u = m[0, 0] * xs + m[0, 1] * ys + m[0, 2]
        v = m[1, 0] * xs + m[1, 1] * ys + m[1, 2]
        # grid_sample with align_corners=False: normalized = (2 * index + 1) / size - 1
        gx = (2 * u + 1) / w - 1
        gy = (2 * v + 1) / h - 1
        g = t.stack([gx, gy], dim=-1).unsqueeze(0)
        y = self.F.grid_sample(self._nchw(src), g, mode='bilinear', padding_mode='zeros', align_corners=False)
        return self._hwc(y)

    def to_yuv420p(self, x) -> bytes:
        """BT.709 limited range, chroma averaged over 2x2 blocks. Halves what goes down the pipe."""
        t = self.torch
        x = x.clamp(0, 1)
        r, g, b = x[..., 0], x[..., 1], x[..., 2]
        y = 16 + 219 * (0.2126 * r + 0.7152 * g + 0.0722 * b)
        cb = 128 + 224 * (-0.114572 * r - 0.385428 * g + 0.5 * b)
        cr = 128 + 224 * (0.5 * r - 0.454153 * g - 0.045847 * b)
        h, w = y.shape
        cb = self.F.avg_pool2d(cb[None, None], 2)[0, 0]
        cr = self.F.avg_pool2d(cr[None, None], 2)[0, 0]
        planes = [p.add(0.5).clamp(0, 255).to(t.uint8).flatten() for p in (y, cb, cr)]
        return t.cat(planes).cpu().numpy().tobytes()


_backend = None


def get_backend(prefer: str | None = None):
    """The torch backend when CUDA works (and AVE_BACKEND is not 'numpy'), else numpy."""
    global _backend
    choice = (prefer or os.environ.get('AVE_BACKEND') or 'auto').lower()
    if _backend is not None and (choice == 'auto' or choice == _backend.name):
        return _backend
    if choice in ('auto', 'torch', 'cuda'):
        st = torch_status()
        if st['cuda']:
            _backend = TorchBackend('cuda')
            return _backend
        if choice == 'torch':
            try:
                _backend = TorchBackend('cpu')
                return _backend
            except Exception:  # noqa: BLE001
                pass
    _backend = NumpyBackend()
    return _backend
