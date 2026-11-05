#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三体问题数值模拟（二维牛顿引力，G=1，三颗质量均为 1）。

对给定初值（Chenciner-Montgomery "8 字" 轨道初值）做真实的固定步长 RK4 时间积分，
不使用任何外部轨迹数据，也不用参数化曲线代替积分。

产物：
  outputs/three_body.csv   等间隔采样（每 10 步导出，含初值与终值）
  outputs/metrics.json     从真实积分统计得到的能量/角动量/质心/最近距离等指标
  outputs/three_body.png   等比例 x/y 轨迹图 + 守恒量误差子图
  outputs/three_body.html  自包含中文动画（内嵌与 CSV 同源的采样数据）

运行：python3 outputs/simulate_three_body.py
依赖：numpy、matplotlib
"""
from __future__ import annotations

import csv
import datetime as _dt
import json
import math
import os
import platform
import sys

import numpy as np

# ---------------------------------------------------------------------------- 参数
G = 1.0
MASS = np.array([1.0, 1.0, 1.0])

INITIAL_POSITIONS = [(-0.97000436, 0.24308753), (0.97000436, -0.24308753), (0.0, 0.0)]
INITIAL_VELOCITIES = [(0.466203685, 0.43236573), (0.466203685, 0.43236573),
                      (-0.93240737, -0.86473146)]

DT = 0.001
T_START = 0.0
T_END = 12.65
SAMPLE_EVERY = 10  # 每 10 个积分步导出一个样本 -> 采样间隔 0.01

CSV_HEADER = ["t",
              "x1", "y1", "vx1", "vy1",
              "x2", "y2", "vx2", "vy2",
              "x3", "y3", "vx3", "vy3"]

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(OUT_DIR, "three_body.csv")
METRICS_PATH = os.path.join(OUT_DIR, "metrics.json")
PNG_PATH = os.path.join(OUT_DIR, "three_body.png")
HTML_PATH = os.path.join(OUT_DIR, "three_body.html")


# ------------------------------------------------------------------- 物理与积分器
def acceleration(pos: np.ndarray) -> np.ndarray:
    """二维牛顿引力加速度（无软化）：a_i = sum_j G m_j (r_j-r_i)/|r_j-r_i|^3。"""
    acc = np.zeros_like(pos)
    n = pos.shape[0]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            d = pos[j] - pos[i]
            r2 = float(d[0] * d[0] + d[1] * d[1])
            if not (r2 > 0.0):
                raise ZeroDivisionError(f"星 {i} 与星 {j} 重合，无软化时力奇异")
            acc[i] += G * MASS[j] * d / (r2 * math.sqrt(r2))
    return acc


def rk4_step(pos: np.ndarray, vel: np.ndarray, h: float):
    """经典四阶显式 Runge-Kutta 单步（状态 = 位置 + 速度）。"""
    k1p, k1v = vel, acceleration(pos)
    k2p, k2v = vel + 0.5 * h * k1v, acceleration(pos + 0.5 * h * k1p)
    k3p, k3v = vel + 0.5 * h * k2v, acceleration(pos + 0.5 * h * k2p)
    k4p, k4v = vel + h * k3v, acceleration(pos + h * k3p)
    new_pos = pos + (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p)
    new_vel = vel + (h / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v)
    return new_pos, new_vel


def energy(pos: np.ndarray, vel: np.ndarray) -> float:
    ke = 0.5 * float(np.sum(MASS[:, None] * vel * vel))
    pe = 0.0
    for i in range(pos.shape[0]):
        for j in range(i + 1, pos.shape[0]):
            pe -= G * MASS[i] * MASS[j] / float(np.linalg.norm(pos[j] - pos[i]))
    return ke + pe


def angular_momentum_z(pos: np.ndarray, vel: np.ndarray) -> float:
    return float(np.sum(MASS * (pos[:, 0] * vel[:, 1] - pos[:, 1] * vel[:, 0])))


def center_of_mass(pos: np.ndarray) -> np.ndarray:
    return np.sum(MASS[:, None] * pos, axis=0) / float(MASS.sum())


def min_pair_distance(pos: np.ndarray) -> float:
    n = pos.shape[0]
    return min(float(np.linalg.norm(pos[j] - pos[i]))
               for i in range(n) for j in range(i + 1, n))


def integrate(pos0, vel0, dt, n_steps, every):
    """固定步长 RK4 积分，返回全部步状态与等间隔采样的步索引。"""
    traj = np.empty((n_steps + 1, 3, 2))
    vraj = np.empty((n_steps + 1, 3, 2))
    traj[0], vraj[0] = pos0.copy(), vel0.copy()
    pos, vel = pos0.copy(), vel0.copy()
    for k in range(1, n_steps + 1):
        pos, vel = rk4_step(pos, vel, dt)
        traj[k], vraj[k] = pos, vel
    keep = np.arange(0, n_steps + 1, every)
    if keep[-1] != n_steps:  # 保证末点（终值）被采样
        keep = np.append(keep, n_steps)
    return traj, vraj, keep


def state_row(t, pos, vel):
    row = [float(t)]
    for i in range(3):
        row.extend([float(pos[i, 0]), float(pos[i, 1]), float(vel[i, 0]), float(vel[i, 1])])
    return row


def fmt(v: float) -> str:
    """最短可精确回读（round-trip）的十进制表示。"""
    return repr(float(v))


# ------------------------------------------------------------------------- 主流程
def main() -> int:
    pos0 = np.array(INITIAL_POSITIONS, dtype=float)
    vel0 = np.array(INITIAL_VELOCITIES, dtype=float)

    span = T_END - T_START
    n_steps = int(round(span / DT))
    if abs(n_steps * DT - span) > 1e-12:
        raise SystemExit(f"积分区间不是步长的整数倍：{span} / {DT}")
    assert n_steps == 12650, n_steps

    sample_interval = SAMPLE_EVERY * DT
    print(f"[积分] dt={DT} 步数={n_steps} 区间=[{T_START}, {T_END}] 采样间隔={sample_interval}")
    traj, vraj, keep = integrate(pos0, vel0, DT, n_steps, SAMPLE_EVERY)

    if not (np.all(np.isfinite(traj)) and np.all(np.isfinite(vraj))):
        raise SystemExit("积分过程中出现非有限数值")
    assert keep[0] == 0 and keep[-1] == n_steps

    # ---- 真实逐步守恒量统计
    e_seq = np.array([energy(traj[k], vraj[k]) for k in range(n_steps + 1)])
    l_seq = np.array([angular_momentum_z(traj[k], vraj[k]) for k in range(n_steps + 1)])
    com_seq = np.array([center_of_mass(traj[k]) for k in range(n_steps + 1)])
    dmin_seq = np.array([min_pair_distance(traj[k]) for k in range(n_steps + 1)])
    com_drift = np.linalg.norm(com_seq - com_seq[0], axis=1)

    e0 = float(e_seq[0])
    l0 = float(l_seq[0])
    max_rel_e = float(np.max(np.abs(e_seq - e0) / abs(e0)))
    max_abs_l = float(np.max(np.abs(l_seq - l0)))
    max_com = float(np.max(com_drift))
    min_pair = float(np.min(dmin_seq))

    # ---- 采样 -> CSV
    rows = [state_row(T_START + int(k) * DT, traj[k], vraj[k]) for k in keep]
    if len(rows) < 1000:
        raise SystemExit(f"样本数不足：{len(rows)}")

    tmp = CSV_PATH + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(CSV_HEADER)
        for r in rows:
            w.writerow([f"{r[0]:.6f}"] + [fmt(v) for v in r[1:]])
    os.replace(tmp, CSV_PATH)
    print(f"[CSV] 样本数={len(rows)} 首行 t={rows[0][0]:.6f} 末行 t={rows[-1][0]:.6f}")

    # ---- 收敛性交叉校验：同一初值用 dt/2 重积分，比较末态
    half = DT / 2.0
    n_half = int(round(span / half))
    traj_h, vraj_h, _ = integrate(pos0, vel0, half, n_half, n_half)
    dev_pos = float(np.max(np.abs(traj_h[-1] - traj[-1])))
    dev_vel = float(np.max(np.abs(vraj_h[-1] - vraj[-1])))
    print(f"[校验] dt/2 末位置最大偏差={dev_pos:.3e} 末速度最大偏差={dev_vel:.3e}")

    final_state = state_row(T_END, traj[n_steps], vraj[n_steps])
    metrics = {
        "G": G,
        "masses": [float(m) for m in MASS],
        "method": "explicit fixed-step 4th-order Runge-Kutta (RK4)，二维牛顿引力三体，无软化项",
        "dt": DT,
        "t_start": T_START,
        "t_end": T_END,
        "n_steps": n_steps,
        "sample_every_steps": SAMPLE_EVERY,
        "sample_interval": sample_interval,
        "sample_count": len(rows),
        "initial_positions": [[float(x), float(y)] for x, y in INITIAL_POSITIONS],
        "initial_velocities": [[float(vx), float(vy)] for vx, vy in INITIAL_VELOCITIES],
        "initial_energy": e0,
        "max_relative_energy_error": max_rel_e,
        "initial_angular_momentum": l0,
        "max_absolute_angular_momentum_error": max_abs_l,
        "max_center_of_mass_norm": max_com,
        "minimum_pair_distance": min_pair,
        "final_state": {
            "t": final_state[0],
            "positions": [[final_state[1], final_state[2]], [final_state[5], final_state[6]],
                          [final_state[9], final_state[10]]],
            "velocities": [[final_state[3], final_state[4]], [final_state[7], final_state[8]],
                           [final_state[11], final_state[12]]],
            "energy": float(e_seq[-1]),
            "angular_momentum": float(l_seq[-1]),
        },
        "center_of_mass_initial": [float(com_seq[0][0]), float(com_seq[0][1])],
        "linear_momentum_initial": [float(v) for v in np.sum(MASS[:, None] * vel0, axis=0)],
        "cross_check_dt_half": {
            "dt": half,
            "n_steps": n_half,
            "max_endpoint_position_difference": dev_pos,
            "max_endpoint_velocity_difference": dev_vel,
        },
        "conservation_extent": {
            "max_absolute_energy_error": float(np.max(np.abs(e_seq - e0))),
            "min_pair_distance_at_step": int(np.argmin(dmin_seq)),
        },
        "units": "无量纲数值单位：G=1、m=1；长度与时间由初值给定，速度=长度/时间，能量=质量·长度^2/时间^2",
        "definitions": {
            "initial_energy": "E = sum 1/2 m_i |v_i|^2 - sum_{i<j} G m_i m_j / |r_i-r_j| 在 t=0 的值",
            "max_relative_energy_error": "max_t |E(t)-E(0)|/|E(0)|，在全部 12651 个积分步上统计",
            "angular_momentum": "二维轨道角动量 z 分量 Lz = sum m_i (x_i vy_i - y_i vx_i)",
            "max_absolute_angular_momentum_error": "max_t |Lz(t)-Lz(0)|",
            "max_center_of_mass_norm": "max_t |COM(t)-COM(0)|；本初值总动量为 0，等于质心位置的模",
            "minimum_pair_distance": "min_t min_{i<j} |r_i-r_j|，逐步统计",
            "sample_count": "CSV 数据行数（不含表头），等间隔且含初值与终值",
        },
        "run_environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "generated_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        },
    }
    tmp = METRICS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, METRICS_PATH)
    print("[metrics] 已写出")

    # ---- 自检：RK4 在该精度下应保持很好的守恒性
    assert max_rel_e < 1e-6, f"能量相对误差过大：{max_rel_e}"
    assert max_abs_l < 1e-6, f"角动量误差过大：{max_abs_l}"
    assert max_com < 1e-9, f"质心漂移过大：{max_com}"

    plot(traj[keep], e_seq[keep], l_seq[keep], e0, l0, rows,
         max_rel_e, max_abs_l, max_com, min_pair, dev_pos)
    write_html(rows, metrics, sample_interval)

    print(f"[结果] E0={e0:.12f} max|dE/E0|={max_rel_e:.3e} L0={l0:.12f} max|dLz|={max_abs_l:.3e}")
    print(f"[结果] 质心漂移={max_com:.3e} 最小星距={min_pair:.9f} 样本={len(rows)}")
    return 0


# --------------------------------------------------------------------------- 绘图
def plot(samples_pos, e_seq, l_seq, e0, l0, rows, max_rel_e, max_abs_l, max_com, min_pair, dev):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    cjk = [f for f in ("Noto Sans CJK SC", "WenQuanYi Zen Hei", "Noto Sans CJK JP")
           if any(x.name == f for x in font_manager.fontManager.ttflist)]
    if cjk:
        plt.rcParams["font.family"] = cjk + ["DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    ts = np.array([r[0] for r in rows])
    colors = ("#d62728", "#1f77b4", "#2ca02c")
    names = ("星 1", "星 2", "星 3")
    styles = ("-", "--", "-.")

    fig = plt.figure(figsize=(13.6, 9.2), dpi=150)
    gs = fig.add_gridspec(2, 4, height_ratios=[3.15, 1.05], width_ratios=[1, 1, 1, 0.92],
                          hspace=0.30, wspace=0.22)
    ax = fig.add_subplot(gs[0, 0:3])
    ax2 = fig.add_subplot(gs[1, 0:3])
    ax_info = fig.add_subplot(gs[1, 3])
    ax_info.axis("off")
    gsr = gs[0, 3].subgridspec(3, 1, hspace=0.42)
    mini = [fig.add_subplot(gsr[i]) for i in range(3)]

    for i, c, nm, ls in zip(range(3), colors, names, styles):
        x, y = samples_pos[:, i, 0], samples_pos[:, i, 1]
        ax.plot(x, y, color=c, lw=1.6, ls=ls, alpha=0.9,
                label=(f"{nm}  初值 r=({INITIAL_POSITIONS[i][0]:+.8f}, {INITIAL_POSITIONS[i][1]:+.8f})"
                       f"  v=({INITIAL_VELOCITIES[i][0]:+.9f}, {INITIAL_VELOCITIES[i][1]:+.9f})"))
        ax.scatter(x[0], y[0], color=c, marker="*", s=230, zorder=6,
                   edgecolor="white", linewidth=0.8)
        ax.scatter(x[-1], y[-1], color=c, marker="o", s=46, zorder=6,
                   facecolor="none", linewidth=1.7)
        ax.annotate(f"{nm} 起点", (x[0], y[0]), textcoords="offset points",
                    xytext=(9, 7), fontsize=8.5, color=c)

    lim = (min(samples_pos[:, :, 0].min(), samples_pos[:, :, 1].min()) - 0.12,
           max(samples_pos[:, :, 0].max(), samples_pos[:, :, 1].max()) + 0.12)
    ax.set_aspect("equal", adjustable="box")
    ax.set_xlim(lim[0], lim[1])
    ax.set_ylim(lim[0], lim[1])
    ax.grid(True, ls=":", alpha=0.5)
    ax.set_xlabel("x（无量纲长度单位，G=1、m=1）")
    ax.set_ylabel("y（无量纲长度单位）")
    ax.set_title("三体数值模拟轨迹：固定步长 RK4 真实积分（非示意图、非参数化曲线）", fontsize=12.5)
    ax.legend(loc="lower left", fontsize=7.6, framealpha=0.93, ncol=1)
    ax.scatter([0], [0], marker="+", color="gray", s=70, alpha=0.7)

    # 三颗星各自的轨迹分面展示（同一尺度、同一颜色），避免重叠后难以分辨
    for i, (a, c, nm, ls) in enumerate(zip(mini, colors, names, styles)):
        x, y = samples_pos[:, i, 0], samples_pos[:, i, 1]
        a.plot(x, y, color=c, lw=1.3, ls=ls)
        a.scatter(x[0], y[0], color=c, marker="*", s=90, zorder=5, edgecolor="white", linewidth=0.5)
        a.scatter(x[-1], y[-1], color=c, marker="o", s=26, zorder=5, facecolor="none", linewidth=1.3)
        a.set_aspect("equal")
        a.set_xlim(lim[0], lim[1])
        a.set_ylim(lim[0], lim[1])
        a.set_xticks([-1.0, 0.0, 1.0])
        a.set_yticks([-0.5, 0.0, 0.5])
        a.tick_params(labelsize=6.5)
        a.grid(True, ls=":", alpha=0.4)
        a.set_title(f"{nm} 单独轨迹（同一尺度）", fontsize=8.2, color=c, pad=2.5)

    box = (f"数值方法与参数\n"
           f"G = 1，m1 = m2 = m3 = 1，无软化项\n"
           f"积分器：显式经典 RK4，固定步长 dt = {DT}\n"
           f"时间：t ∈ [{T_START}, {T_END}]（含端点），{int(round((T_END - T_START) / DT))} 步\n"
           f"导出 {len(rows)} 个等间隔样本（每 {SAMPLE_EVERY} 步，Δt = {SAMPLE_EVERY * DT}）\n"
           f"单位：无量纲（长度、时间由初值给定）\n\n"
           f"守恒量（逐步统计）\n"
           f"E0 = {e0:.9f}\n"
           f"max|ΔE/E0| = {max_rel_e:.2e}\n"
           f"Lz0 = {l0:.3e}\n"
           f"max|ΔLz| = {max_abs_l:.2e}\n"
           f"质心最大漂移 = {max_com:.2e}\n"
           f"最小星间距离 = {min_pair:.6f}\n"
           f"dt/2 交叉校验末位置偏差 = {dev:.2e}\n\n"
           f"标记：★ 初值位置，○ 终值位置\n"
           f"说明：三颗星沿同一条 8 字轨道错峰运动（周期轨道），\n"
           f"故主图中曲线重合；右侧分面给出各自的轨迹与相位。")
    ax_info.text(0.0, 0.98, box, transform=ax_info.transAxes, ha="left", va="top", fontsize=7.9,
                 linespacing=1.45,
                 bbox=dict(boxstyle="round,pad=0.5", fc="#f7f7f7", ec="#bbbbbb", alpha=0.95))

    ax2.semilogy(ts, np.maximum(np.abs(e_seq - e0) / abs(e0), 1e-18), color="#d62728",
                 lw=1.4, label="|ΔE/E₀|  能量相对误差")
    ax2.semilogy(ts, np.maximum(np.abs(l_seq - l0), 1e-18), color="#1f77b4",
                 lw=1.4, label="|ΔLz|  角动量绝对误差")
    ax2.set_xlabel("t")
    ax2.set_ylabel("误差（log）")
    ax2.set_title("沿积分时间的守恒量漂移（全部积分步逐步计算，按采样点绘制）", fontsize=10.2)
    ax2.grid(True, which="both", ls=":", alpha=0.45)
    ax2.legend(fontsize=8.5, loc="lower right", framealpha=0.93)
    ax2.set_xlim(ts[0], ts[-1])

    fig.suptitle("三体初值问题数值积分交付（二维牛顿引力 · Chenciner–Montgomery 8 字初值）",
                 y=0.985, fontsize=11.5)
    fig.text(0.5, 0.005,
             f"数值方法：显式经典 RK4，固定步长 dt={DT}，无软化；数据来自 outputs/three_body.csv 的同一次真实积分",
             ha="center", fontsize=8.5)
    tmp = PNG_PATH + ".tmp.png"
    fig.savefig(tmp, bbox_inches="tight")
    plt.close(fig)
    os.replace(tmp, PNG_PATH)
    print("[PNG] 已写出")


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>三体数值模拟动画 · 8 字轨道（固定步长 RK4, dt=0.001）</title>
<style>
:root{--bg:#0b1020;--card:#151d33;--line:#26324f;--fg:#e9eef7;--dim:#9fb0cc;--acc:#5cc8ff;
--s1:#ff6b6b;--s2:#4dd0e1;--s3:#ffd166}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:radial-gradient(1200px 700px at 70% -10%,#16233f 0%,var(--bg) 60%);color:var(--fg);
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
line-height:1.55;-webkit-text-size-adjust:100%}
header{padding:18px clamp(12px,3vw,28px) 4px}
h1{margin:0 0 6px;font-size:clamp(19px,3.4vw,27px)}
.sub{margin:0;color:var(--dim);font-size:clamp(12px,2.3vw,14px)}
.tag{display:inline-block;background:#1d2b4d;border:1px solid var(--line);border-radius:999px;
padding:2px 9px;margin:3px 4px 0 0;font-size:12px;color:#cfe1ff}
main{display:grid;gap:14px;padding:12px clamp(12px,3vw,28px) 24px;grid-template-columns:1fr}
@media (min-width:980px){main{grid-template-columns:minmax(0,1.2fr) minmax(360px,.95fr)}}
.card{background:linear-gradient(180deg,var(--card),#121a2e);border:1px solid var(--line);border-radius:14px;padding:12px}
canvas{display:block;width:100%;height:auto;aspect-ratio:1/1;max-height:76vh;border-radius:12px;
background:radial-gradient(900px 600px at 50% 40%,#0d1730 0%,#070c19 100%);touch-action:manipulation}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;font-size:13px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;
padding:3px 10px;background:#101a30;color:var(--dim)}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block;box-shadow:0 0 8px currentColor}
.hud{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:13px;color:var(--dim);
font-variant-numeric:tabular-nums}
.hud b{color:var(--fg);font-weight:600}
.status{margin-top:8px;font-size:13px;color:var(--acc)}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
button,select,input[type=checkbox]{font:inherit}
button{cursor:pointer;background:#1b2a4b;color:var(--fg);border:1px solid #35548c;border-radius:10px;
padding:10px 16px;min-height:46px}
button.primary{background:#21557c;border-color:#4d9ac5}
button:active{transform:translateY(1px)}
select{background:#101a30;color:var(--fg);border:1px solid var(--line);border-radius:10px;
padding:8px 10px;min-height:46px}
label{font-size:13px;color:var(--dim)}
.slider-label{display:block;margin:16px 0 2px;font-size:14px;color:var(--fg);font-weight:600}
input[type=range]{width:100%;height:36px;background:transparent;accent-color:var(--acc);touch-action:none}
.slider-row{display:flex;align-items:center;gap:10px}
output{font-variant-numeric:tabular-nums;font-size:13px;color:var(--acc);min-width:8.5em;text-align:right}
.ticks{display:flex;justify-content:space-between;font-size:11px;color:#6f83a5}
h2{font-size:15px;margin:18px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{padding:5px 6px;text-align:right;border-bottom:1px solid #1d2740}
th:first-child,td:first-child{text-align:left;color:var(--dim)}
th{color:#cfe1ff;font-weight:600;background:#111a30}
ul{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--dim)}
ul li{margin:4px 0}
code{background:#0e1729;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:12.5px;color:#bfe3ff}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;color:var(--dim)}
.kv div:nth-child(2n){font-variant-numeric:tabular-nums;color:var(--fg);text-align:right}
.warn{margin-top:14px;border-left:3px solid var(--s3);background:#1a1f2e;border-radius:8px;
padding:10px 12px;font-size:13px;color:#e6dcc0}
footer{padding:0 clamp(12px,3vw,28px) 24px;color:#6f83a5;font-size:12px}
@media (max-width:620px){canvas{max-height:54vh}button{flex:1 1 auto}th,td{font-size:11.5px;padding:4px 3px}
.hud{font-size:12px}}
</style>
</head>
<body>
<header>
<h1>三体问题数值模拟动画 <span style="font-weight:400;color:var(--dim)">· 8 字轨道</span></h1>
<p class="sub">二维牛顿引力 · 固定步长 RK4 真实时间积分（非示意图，也不是用 8 字曲线参数化函数画的）</p>
<p class="sub">
<span class="tag">G = 1</span><span class="tag">m₁ = m₂ = m₃ = 1</span><span class="tag">无软化项</span>
<span class="tag">dt = 0.001</span><span class="tag">t: 0 → 12.65（含端点）</span><span class="tag">12650 个积分步</span>
<span class="tag">内嵌 __SAMPLE_COUNT__ 个采样点</span><span class="tag">采样间隔 __SAMPLE_DT__</span>
</p>
</header>

<main>
<section class="card">
<canvas id="cv" aria-label="三颗恒星在二维平面内运动的数值模拟动画画布"></canvas>
<div class="legend">
<span class="chip"><i class="dot" style="background:var(--s1);color:var(--s1)"></i>星 1（红）</span>
<span class="chip"><i class="dot" style="background:var(--s2);color:var(--s2)"></i>星 2（青）</span>
<span class="chip"><i class="dot" style="background:var(--s3);color:var(--s3)"></i>星 3（黄）</span>
<span class="chip">○ 圆环＝初值位置</span>
<span class="chip">亮线＝近期轨迹，暗线＝全程轨迹</span>
</div>
<div class="hud">
<span>当前 <b id="hud-t">t = 0.000</b></span>
<span>能量 <b id="hud-e">E = —</b></span>
<span>相对偏差 <b id="hud-de">ΔE/E₀ = —</b></span>
<span>角动量 <b id="hud-l">Lz = —</b></span>
<span>此刻最小星距 <b id="hud-d">d = —</b></span>
</div>
<div class="status" id="status" role="status">状态：已暂停</div>
</section>

<section class="card">
<div class="controls">
<button id="btn-toggle" class="primary" type="button" aria-pressed="false">▶ 继续</button>
<button id="btn-reset" type="button">⟲ 重置</button>
<label for="speed">播放倍速
<select id="speed">
<option value="0.25">0.25×</option>
<option value="0.5">0.5×</option>
<option value="1" selected>1×（约 12.65 秒播完）</option>
<option value="2">2×</option>
<option value="4">4×</option>
</select>
</label>
<label for="loop"><input type="checkbox" id="loop"> 循环播放</label>
</div>
<label class="slider-label" for="slider">时间滑块 —— 拖动即可定位到任意采样时刻（t 从 0 到 12.65）</label>
<div class="slider-row">
<input type="range" id="slider" min="0" max="__MAX_INDEX__" step="1" value="0" aria-label="时间滑块，单位：模拟时间">
<output id="slider-out">t = 0.000</output>
</div>
<div class="ticks"><span>0</span><span>3.16</span><span>6.33</span><span>9.49</span><span>12.65</span></div>

<h2>初值（与 outputs/three_body.csv 首行逐位一致）</h2>
<table>
<thead><tr><th>星体</th><th>x</th><th>y</th><th>vx</th><th>vy</th></tr></thead>
<tbody>__INIT_TABLE__</tbody>
</table>
<p class="sub" style="margin-top:8px">总动量恰为 0，质心固定在原点；G 与三颗质量均为 1，使用无量纲单位。</p>

<h2>数值方法与采样</h2>
<div class="kv">
<div>积分器</div><div>显式经典四阶 Runge-Kutta（RK4），固定步长</div>
<div>运动方程</div><div>二维牛顿引力 r̈ᵢ = Σⱼ Gmⱼ(rⱼ−rᵢ)/|rⱼ−rᵢ|³</div>
<div>步长 dt</div><div>0.001</div>
<div>积分步数</div><div>12650（t: 0 → 12.65，含端点）</div>
<div>导出样本</div><div>每 10 步 1 点，共 __SAMPLE_COUNT__ 点</div>
<div>软化</div><div>无（ε = 0）</div>
<div>动画数据</div><div>与 CSV 同源的采样状态，逐帧线性插值</div>
</div>

<h2>守恒量误差（真实积分逐步统计）</h2>
<div class="kv">
<div>初始能量 E₀</div><div>__E0__</div>
<div>最大相对能量误差</div><div>__MAX_REL_E__</div>
<div>初始角动量 Lz₀</div><div>__L0__</div>
<div>最大角动量绝对误差</div><div>__MAX_ABS_L__</div>
<div>质心最大漂移</div><div>__MAX_COM__</div>
<div>全程最小星间距离</div><div>__MIN_PAIR__</div>
<div>dt/2 交叉校验末位置偏差</div><div>__DEV__</div>
</div>
<p class="sub" style="margin-top:8px">上述数值来自同一次真实积分并写入 <code>outputs/metrics.json</code>；动画中的实时 E、Lz 由内嵌采样状态现场计算。</p>

<h2>说明与适用边界</h2>
<ul>
<li>这是<b>给定初值下</b>的一次数值模拟，<b>不是三体问题的通解</b>，不能推广到一般初值；三体问题在一般情况下没有闭式解。</li>
<li>本初值是著名的 Chenciner–Montgomery “8 字”周期轨道的近似初值，周期约 6.916，因此 12.65 个时间单位约相当于 1.83 个周期。</li>
<li>RK4 不是辛格式，长时间会缓慢漂移；本次积分在 12.65 个时间单位内的能量/角动量误差见上表。</li>
<li>未加软化项，若两颗星极其接近则力急剧增大，需要更小步长；本例最小星间距离约 __MIN_PAIR_SHORT__。</li>
<li>复现方式：<code>python3 outputs/simulate_three_body.py</code>（依赖 numpy、matplotlib）。本页完全自包含，离线双击即可打开，不引用任何外部资源。</li>
</ul>
<div class="warn">操作提示：暂停时画面与所有读数冻结；点“继续”后按真实采样时间推进；拖动时间滑块可定位；“重置”回到 t = 0 并自动暂停。空格键＝暂停/继续，R 键＝重置。</div>
</section>
</main>

<footer>数据：outputs/three_body.csv · 指标：outputs/metrics.json · 脚本：outputs/simulate_three_body.py · 生成时间（UTC）：__GENERATED__</footer>

<script id="sim-data" type="application/json">__DATA_JSON__</script>
<script>
"use strict";
(function(){
var DATA=JSON.parse(document.getElementById("sim-data").textContent);
var S=DATA.samples,NS=S.length,DT_S=DATA.sample_dt,T0=DATA.t_start,T1=DATA.t_end,M=DATA.masses,Gc=DATA.G;
var COLORS=["#ff6b6b","#4dd0e1","#ffd166"],NAMES=["星 1","星 2","星 3"];
var cv=document.getElementById("cv"),ctx=cv.getContext("2d");
var slider=document.getElementById("slider"),sliderOut=document.getElementById("slider-out");
var btnToggle=document.getElementById("btn-toggle"),btnReset=document.getElementById("btn-reset");
var selSpeed=document.getElementById("speed"),cbLoop=document.getElementById("loop");
var elT=document.getElementById("hud-t"),elE=document.getElementById("hud-e"),elDE=document.getElementById("hud-de");
var elL=document.getElementById("hud-l"),elD=document.getElementById("hud-d"),elStatus=document.getElementById("status");
var tCur=T0,playing=false,speed=1,dragging=false,lastTs=null;

function clamp(v,a,b){return v<a?a:(v>b?b:v);}
function uIndex(t){return clamp((t-T0)/DT_S,0,NS-1);}
function pos(st,i){return [st[1+4*i],st[2+4*i]];}
function vel(st,i){return [st[3+4*i],st[4+4*i]];}
function stateAt(t){
  var u=uIndex(t),i=Math.floor(u),j=Math.min(i+1,NS-1),f=u-i,a=S[i],b=S[j],out=[T0+u*DT_S];
  for(var k=1;k<13;k++)out.push(a[k]+(b[k]-a[k])*f);
  return out;
}
function energy(st){
  var E=0,i,j;
  for(i=0;i<3;i++){var v=vel(st,i);E+=0.5*M[i]*(v[0]*v[0]+v[1]*v[1]);}
  for(i=0;i<3;i++)for(j=i+1;j<3;j++){var pi=pos(st,i),pj=pos(st,j);
    E-=Gc*M[i]*M[j]/Math.hypot(pj[0]-pi[0],pj[1]-pi[1]);}
  return E;
}
function angMom(st){
  var L=0;
  for(var i=0;i<3;i++){var p=pos(st,i),v=vel(st,i);L+=M[i]*(p[0]*v[1]-p[1]*v[0]);}
  return L;
}
function minDist(st){
  var d=Infinity;
  for(var i=0;i<3;i++)for(var j=i+1;j<3;j++){var pi=pos(st,i),pj=pos(st,j);
    var dd=Math.hypot(pj[0]-pi[0],pj[1]-pi[1]);if(dd<d)d=dd;}
  return d;
}

var xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
for(var s=0;s<NS;s++)for(var i=0;i<3;i++){
  var X=S[s][1+4*i],Y=S[s][2+4*i];
  if(X<xmin)xmin=X; if(X>xmax)xmax=X; if(Y<ymin)ymin=Y; if(Y>ymax)ymax=Y;
}
var ccx=0.5*(xmin+xmax),ccy=0.5*(ymin+ymax),half=0.5*Math.max(xmax-xmin,ymax-ymin)*1.18;
xmin=ccx-half;xmax=ccx+half;ymin=ccy-half;ymax=ccy+half;

var W=0,H=0,sc=1,pad=30;
function resize(){
  var dpr=Math.min(window.devicePixelRatio||1,2.5);
  var cssW=cv.clientWidth||600,cssH=cv.clientHeight||cssW;
  cv.width=Math.round(cssW*dpr);cv.height=Math.round(cssH*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);W=cssW;H=cssH;
  sc=Math.min((W-2*pad)/(xmax-xmin),(H-2*pad)/(ymax-ymin));
}
function px(x){return pad+(x-xmin)*sc;}
function py(y){return H-pad-(y-ymin)*sc;}
function grid(){
  ctx.save();
  ctx.strokeStyle="rgba(120,150,200,0.15)";ctx.fillStyle="rgba(150,175,215,0.72)";
  ctx.lineWidth=1;ctx.font="11px system-ui,sans-serif";
  var step=0.5,gx,gy;
  for(gx=Math.ceil(xmin/step)*step;gx<=xmax;gx+=step){
    ctx.beginPath();ctx.moveTo(px(gx),py(ymin));ctx.lineTo(px(gx),py(ymax));ctx.stroke();
    ctx.fillText(gx.toFixed(1),px(gx)-8,H-10);
  }
  for(gy=Math.ceil(ymin/step)*step;gy<=ymax;gy+=step){
    ctx.beginPath();ctx.moveTo(px(xmin),py(gy));ctx.lineTo(px(xmax),py(gy));ctx.stroke();
    ctx.fillText(gy.toFixed(1),4,py(gy)+4);
  }
  ctx.strokeStyle="rgba(120,150,200,0.4)";
  ctx.beginPath();ctx.moveTo(px(xmin),py(0));ctx.lineTo(px(xmax),py(0));
  ctx.moveTo(px(0),py(ymin));ctx.lineTo(px(0),py(ymax));ctx.stroke();
  ctx.restore();
}
function polyline(from,to,alpha,width){
  ctx.lineJoin="round";
  for(var i=0;i<3;i++){
    ctx.globalAlpha=alpha;ctx.strokeStyle=COLORS[i];ctx.lineWidth=width;ctx.beginPath();
    for(var k=from;k<=to;k++){
      var p=S[k],X=px(p[1+4*i]),Y=py(p[2+4*i]);
      if(k===from)ctx.moveTo(X,Y);else ctx.lineTo(X,Y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha=1;
}
function draw(st){
  ctx.clearRect(0,0,W,H);
  grid();
  polyline(0,NS-1,0.22,1);
  var idx=Math.round(uIndex(tCur)),from=Math.max(0,idx-420);
  if(idx>from)polyline(from,idx,0.95,2.3);
  ctx.lineWidth=1.7;ctx.globalAlpha=0.85;
  for(var i=0;i<3;i++){
    ctx.strokeStyle=COLORS[i];ctx.beginPath();
    ctx.arc(px(S[0][1+4*i]),py(S[0][2+4*i]),6.5,0,2*Math.PI);ctx.stroke();
  }
  ctx.globalAlpha=1;
  for(var k=0;k<3;k++){
    var x=px(pos(st,k)[0]),y=py(pos(st,k)[1]),r=8;
    var g=ctx.createRadialGradient(x,y,0,x,y,r*3.2);
    g.addColorStop(0,COLORS[k]);g.addColorStop(0.4,COLORS[k]+"aa");g.addColorStop(1,"rgba(0,0,0,0)");
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r*3.2,0,2*Math.PI);ctx.fill();
    ctx.fillStyle="#ffffff";ctx.beginPath();ctx.arc(x,y,r*0.45,0,2*Math.PI);ctx.fill();
    ctx.fillStyle=COLORS[k];ctx.font="12px system-ui,sans-serif";ctx.fillText(NAMES[k],x+r+3,y-r);
  }
  ctx.fillStyle="rgba(200,220,250,0.88)";ctx.font="12px system-ui,sans-serif";
  ctx.fillText(playing?"运行中":"已暂停",W-70,18);
  ctx.fillText("t = "+tCur.toFixed(3),W-70,34);
}
function sci(v){return v===0?"0":v.toExponential(2);}
function updateHud(st){
  var E=energy(st),L=angMom(st);
  elT.textContent="t = "+st[0].toFixed(3);
  elE.textContent="E = "+E.toFixed(9);
  elDE.textContent="ΔE/E₀ = "+sci((E-DATA.E0)/Math.abs(DATA.E0));
  elL.textContent="Lz = "+L.toFixed(9);
  elD.textContent="d = "+minDist(st).toFixed(6);
  sliderOut.textContent="t = "+st[0].toFixed(3);
}
function setStatus(txt){elStatus.textContent="状态："+txt;}
function setPlaying(on){
  playing=!!on;
  btnToggle.textContent=playing?"⏸ 暂停":"▶ 继续";
  btnToggle.setAttribute("aria-pressed",playing?"true":"false");
  setStatus(playing?("继续 —— 时间正在推进（"+speed+"× 倍速）"):"已暂停（所有状态冻结）");
}

btnToggle.addEventListener("click",function(){
  if(!playing&&tCur>=T1-1e-12)tCur=T0;
  setPlaying(!playing);
});
btnReset.addEventListener("click",function(){
  tCur=T0;slider.value="0";setPlaying(false);setStatus("已重置回 t = 0 并暂停");
});
selSpeed.addEventListener("change",function(){speed=parseFloat(selSpeed.value);});
slider.addEventListener("pointerdown",function(){dragging=true;});
window.addEventListener("pointerup",function(){dragging=false;});
slider.addEventListener("input",function(){
  dragging=true;
  tCur=T0+parseInt(slider.value,10)*DT_S;
  setStatus((playing?"滑块定位（继续运行中）":"滑块定位（保持暂停）")+" t = "+tCur.toFixed(3));
});
slider.addEventListener("change",function(){dragging=false;});
window.addEventListener("keydown",function(e){
  if(e.target&&/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;
  if(e.code==="Space"){e.preventDefault();btnToggle.click();}
  if(e.key==="r"||e.key==="R")btnReset.click();
});

function frame(ts){
  if(lastTs===null)lastTs=ts;
  var dtms=(ts-lastTs)/1000;lastTs=ts;
  if(dtms>0.25)dtms=0.25;
  if(playing){
    tCur+=dtms*speed;
    if(tCur>=T1){
      if(cbLoop.checked)tCur=T0;
      else{tCur=T1;setPlaying(false);setStatus("已到达终值 t = 12.65，自动暂停（可重置或拖动滑块）");}
    }
  }
  if(!dragging)slider.value=String(Math.round(uIndex(tCur)));
  var st=stateAt(tCur);
  draw(st);updateHud(st);
  requestAnimationFrame(frame);
}
window.addEventListener("resize",resize);
resize();
var st0=stateAt(tCur);draw(st0);updateHud(st0);
requestAnimationFrame(frame);
})();
</script>
</body>
</html>
"""


def write_html(rows, metrics, sample_interval):
    data = {
        "G": G,
        "masses": [float(m) for m in MASS],
        "t_start": T_START,
        "t_end": T_END,
        "dt": DT,
        "sample_dt": sample_interval,
        "sample_count": len(rows),
        "E0": metrics["initial_energy"],
        "L0": metrics["initial_angular_momentum"],
        "samples": [[round(v, 12) for v in r] for r in rows],
    }
    init_rows = []
    for i in range(3):
        x, y = INITIAL_POSITIONS[i]
        vx, vy = INITIAL_VELOCITIES[i]
        init_rows.append(
            f"<tr><td>星 {i + 1}（m = 1）</td><td>{x:.8f}</td><td>{y:.8f}</td>"
            f"<td>{vx:.9f}</td><td>{vy:.9f}</td></tr>"
        )
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    assert "</script" not in payload.lower(), "内嵌数据含有会破坏 HTML 的片段"

    html = HTML_TEMPLATE
    for token, value in {
        "__SAMPLE_COUNT__": str(metrics["sample_count"]),
        "__SAMPLE_DT__": f"{sample_interval:g}",
        "__MAX_INDEX__": str(metrics["sample_count"] - 1),
        "__INIT_TABLE__": "\n".join(init_rows),
        "__E0__": f"{metrics['initial_energy']:.12f}",
        "__MAX_REL_E__": f"{metrics['max_relative_energy_error']:.3e}",
        "__L0__": f"{metrics['initial_angular_momentum']:.12f}",
        "__MAX_ABS_L__": f"{metrics['max_absolute_angular_momentum_error']:.3e}",
        "__MAX_COM__": f"{metrics['max_center_of_mass_norm']:.3e}",
        "__MIN_PAIR__": f"{metrics['minimum_pair_distance']:.9f}",
        "__MIN_PAIR_SHORT__": f"{metrics['minimum_pair_distance']:.3f}",
        "__DEV__": f"{metrics['cross_check_dt_half']['max_endpoint_position_difference']:.3e}",
        "__GENERATED__": metrics["run_environment"]["generated_utc"],
        "__DATA_JSON__": payload,
    }.items():
        html = html.replace(token, value)
    assert "__DATA_JSON__" not in html and "__E0__" not in html

    tmp = HTML_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(html)
    os.replace(tmp, HTML_PATH)
    size_kb = os.path.getsize(HTML_PATH) / 1024.0
    print(f"[HTML] 内嵌 {metrics['sample_count']} 个样本，{size_kb:.0f} KB")


if __name__ == "__main__":
    sys.exit(main())