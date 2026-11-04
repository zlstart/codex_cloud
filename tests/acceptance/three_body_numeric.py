"""Independent Newtonian dynamics shared by real-output acceptance checks."""

import math

INITIAL = [
    -0.97000436,
    0.24308753,
    0.97000436,
    -0.24308753,
    0.0,
    0.0,
    0.466203685,
    0.43236573,
    0.466203685,
    0.43236573,
    -0.93240737,
    -0.86473146,
]
HEADERS = ["t", "x1", "y1", "vx1", "vy1", "x2", "y2", "vx2", "vy2", "x3", "y3", "vx3", "vy3"]


def energy(s):
    kinetic = sum(x * x for x in s[6:]) / 2
    potential = -sum(
        1 / math.hypot(s[2 * i] - s[2 * j], s[2 * i + 1] - s[2 * j + 1]) for i, j in ((0, 1), (0, 2), (1, 2))
    )
    return kinetic + potential


def angular(s):
    return sum(s[2 * i] * s[7 + 2 * i] - s[2 * i + 1] * s[6 + 2 * i] for i in range(3))


def com(s):
    return math.hypot(sum(s[0:6:2]) / 3, sum(s[1:6:2]) / 3)


def derivative(s):
    acc = [0.0] * 6
    for i, j in ((0, 1), (0, 2), (1, 2)):
        dx = s[j * 2] - s[i * 2]
        dy = s[j * 2 + 1] - s[i * 2 + 1]
        factor = (dx * dx + dy * dy) ** -1.5
        ax = dx * factor
        ay = dy * factor
        acc[i * 2] += ax
        acc[i * 2 + 1] += ay
        acc[j * 2] -= ax
        acc[j * 2 + 1] -= ay
    return s[6:] + acc


def rk4(s, h):
    a = derivative(s)
    b = derivative([s[i] + h * a[i] / 2 for i in range(12)])
    c = derivative([s[i] + h * b[i] / 2 for i in range(12)])
    d = derivative([s[i] + h * c[i] for i in range(12)])
    return [s[i] + h * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6 for i in range(12)]
