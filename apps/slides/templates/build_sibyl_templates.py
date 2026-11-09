#!/usr/bin/env python3
"""Generate the Sibyl Slides template families (Template V2 JSON).

    python3 apps/slides/templates/build_sibyl_templates.py

Writes templates/<family>/template.json plus static assets (Inter font, the
tinted Sibyl mark, a thumbnail). Copyright Sibyl contributors, Apache-2.0.

Design system
-------------
* 1280 x 720 canvas, 8 px grid, safe margins 72 px left/right, 64 px top,
  48 px bottom; content never crosses the safe area.
* Type scale (per family): display, title, subtitle, body, caption.
* Every editable text box has a max_length derived from its geometry
  (characters per line x lines x 0.85), so generated text fits without
  overflow; the model is told to stay within it.
* Repeated items (agenda, KPI cards, timeline steps, people) are flex/grid
  regions so 2-6 items lay out evenly with consistent gaps.
* Footer: optional subtle Sibyl mark + slide number (per family).
"""
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_SLIDES = ROOT.parent
INTER = REPO_SLIDES / "servers/nextjs/public/vendor/fonts/sans_serif/inter/Inter[opsz,wght].ttf"
MARK_MASK = REPO_SLIDES / "servers/nextjs/public/brand/sibyl-mark-mask.png"

W, H = 1280, 720
FONT = "Inter"
IMAGE_PLACEHOLDER = "/static/images/replaceable_template_image.png"
ICON_PLACEHOLDER = "/static/icons/placeholder.svg"

FAMILIES = {
    "sibyl-graphite": {
        "name": "Sibyl Graphite",
        "description": "Calm and light: graphite ink, sage accent, quiet surfaces. The default Sibyl look for most decks.",
        "bg": "#FFFFFF", "surface": "#F7F7F5", "subtle": "#F1F2EF", "ink": "#1D211F", "text2": "#646B67",
        "text3": "#8B918D", "border": "#E4E7E2", "accent": "#596C5D", "accent_soft": "#E9EEE8",
        "on_ink": "#FAFAF8", "chart": ["#1D211F", "#596C5D", "#8FA394", "#6B7F95", "#A86F38", "#C9CFC8"],
        "scale": {"display": 60, "title": 38, "subtitle": 22, "body": 18, "caption": 13, "kpi": 52},
        "margin": 72, "footer": True, "mark": True, "radius": 16,
    },
    "sibyl-night": {
        "name": "Sibyl Night",
        "description": "The dark Sibyl variant: deep graphite canvas, soft light text and a sage accent. Good for keynotes and screens.",
        "bg": "#121413", "surface": "#1B1D1C", "subtle": "#222624", "ink": "#ECEDEA", "text2": "#A3A9A5",
        "text3": "#7C827E", "border": "#2B2F2D", "accent": "#9DB3A2", "accent_soft": "#26302A",
        "on_ink": "#121413", "chart": ["#ECEDEA", "#9DB3A2", "#6F8574", "#8FA6BD", "#D6A46D", "#4A524D"],
        "scale": {"display": 60, "title": 38, "subtitle": 22, "body": 18, "caption": 13, "kpi": 52},
        "margin": 72, "footer": True, "mark": True, "radius": 16,
    },
    "sibyl-editorial": {
        "name": "Sibyl Editorial",
        "description": "Large confident headlines and generous whitespace on a warm canvas. For narratives, essays and pitches.",
        "bg": "#FBFBF9", "surface": "#F3F3F0", "subtle": "#ECEDEA", "ink": "#1D211F", "text2": "#5A605C",
        "text3": "#8B918D", "border": "#DCDFD9", "accent": "#1D211F", "accent_soft": "#ECEDEA",
        "on_ink": "#FBFBF9", "chart": ["#1D211F", "#596C5D", "#A9B1AB", "#6B7F95", "#A86F38", "#D5D9D3"],
        "scale": {"display": 76, "title": 48, "subtitle": 24, "body": 19, "caption": 13, "kpi": 64},
        "margin": 96, "footer": True, "mark": False, "radius": 4,
    },
    "sibyl-data": {
        "name": "Sibyl Data",
        "description": "Dense and chart-forward: compact type, KPI strips and large charts. For reports, reviews and dashboards.",
        "bg": "#FFFFFF", "surface": "#F7F7F5", "subtle": "#F1F2EF", "ink": "#1D211F", "text2": "#646B67",
        "text3": "#8B918D", "border": "#E4E7E2", "accent": "#596C5D", "accent_soft": "#E9EEE8",
        "on_ink": "#FAFAF8", "chart": ["#596C5D", "#1D211F", "#6B7F95", "#A86F38", "#327E62", "#B84F58"],
        "scale": {"display": 48, "title": 30, "subtitle": 18, "body": 15, "caption": 12, "kpi": 44},
        "margin": 56, "footer": True, "mark": True, "radius": 10,
    },
}


# ── element helpers ───────────────────────────────────────────────────────────


def capacity(width: float, height: float, size: float, line_height: float, factor: float = 0.85) -> int:
    per_line = max(1, int(width / (size * 0.54)))
    lines = max(1, int(height // (size * line_height)))
    return max(4, int(per_line * lines * factor))


def font(f, size, color, bold=False, line_height=1.25, letter_spacing=None):
    out = {"size": size, "family": FONT, "color": color, "bold": bold, "italic": False, "line_height": line_height}
    if letter_spacing is not None:
        out["letter_spacing"] = letter_spacing
    return out


def text(name, x, y, w, h, size, color, sample, *, bold=False, align="left", valign="top", lh=1.25,
         decorative=False, max_length=None, min_length=None, letter_spacing=None):
    fnt = font(None, size, color, bold, lh, letter_spacing)
    cap = max_length or capacity(w, h, size, lh)
    return {
        "type": "text",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "font": dict(fnt, ellipsis=True),
        "alignment": {"horizontal": align, "vertical": valign},
        "runs": [{"text": sample, "font": fnt}],
        "decorative": decorative,
        "name": name,
        "max_length": cap,
        "min_length": min_length if min_length is not None else max(1, min(cap, int(cap * 0.25))),
    }


def bullets(name, x, y, w, h, size, color, items, *, max_items=5, min_items=2, marker="bullet", gap=12, lh=1.3):
    per_item_lines = max(1, int((h - gap * (max_items - 1)) / max_items // (size * lh)))
    item_cap = capacity(w - 24, per_item_lines * size * lh, size, lh)
    fnt = font(None, size, color, False, lh)
    return {
        "type": "text-list",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "font": fnt,
        "marker": marker,
        "gap": gap,
        "marker_gap": 12,
        "items": [[{"text": item, "font": fnt}] for item in items],
        "decorative": False,
        "name": name,
        "max_items": max_items,
        "min_items": min_items,
        "max_item_length": item_cap,
        "min_item_length": min(item_cap, 12),
    }


def rect(x, y, w, h, fill, radius=0, stroke=None, name=None):
    el = {
        "type": "vector",
        "shape": "polygon",
        "points": [{"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x + w, "y": y + h}, {"x": x, "y": y + h}],
        "closed": True,
        "fill": {"color": fill},
    }
    if radius:
        el["corner_radii"] = [radius] * 4
    if stroke:
        el["stroke"] = {"color": stroke, "width": 1}
    if name:
        el["name"] = name
    return el


def ellipse(x, y, d, fill):
    return {
        "type": "vector",
        "shape": "ellipse",
        "points": [{"x": x, "y": y}, {"x": x + d, "y": y + d}],
        "closed": True,
        "fill": {"color": fill},
    }


def image(name, x, y, w, h, radius=0, prompt=None):
    el = {
        "type": "image",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "data": IMAGE_PLACEHOLDER,
        "fit": "cover",
        "decorative": False,
        "name": name,
        "is_icon": False,
    }
    if radius:
        el["border_radius"] = {"tl": radius, "tr": radius, "bl": radius, "br": radius}
    if prompt:
        el["prompt"] = prompt
    return el


def icon(name, x, y, size, color):
    return {
        "type": "image",
        "position": {"x": x, "y": y},
        "size": {"width": size, "height": size},
        "data": ICON_PLACEHOLDER,
        "fit": "contain",
        "color": color,
        "decorative": False,
        "name": name,
        "is_icon": True,
        "icon_type": "regular",
    }


def chart(name, x, y, w, h, kind, t, categories, series, *, legend=True):
    return {
        "type": "chart",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "chart_type": kind,
        "text_color": t["text2"],
        "legend_color": t["text2"],
        "colors": t["chart"],
        "x_axis": kind not in ("pie", "donut"),
        "y_axis": kind not in ("pie", "donut"),
        "axis_color": t["border"],
        "categories": categories,
        "series": series,
        "legend": legend,
        "legend_position": "bottom" if kind not in ("pie", "donut") else "right",
        "x_axis_grid": False,
        "y_axis_grid": kind not in ("pie", "donut"),
        "grid_color": t["border"],
        "decorative": False,
        "name": name,
    }


def table(name, x, y, w, h, t, header, rows, *, max_rows=6, max_cols=4):
    s = t["scale"]
    border = {"color": t["border"], "width": 1}
    none = {"color": t["border"], "width": 0}

    def cell(value, head=False):
        fnt = font(None, s["caption"] + 2 if head else s["body"] - 2, t["ink"] if not head else t["text2"], head, 1.3)
        return {
            "color": {"color": t["subtle"] if head else t["bg"]},
            "font": fnt,
            "alignment": "left",
            "borders": {"top": none, "right": none, "left": none, "bottom": border},
            "runs": [{"text": value, "font": fnt}],
        }

    return {
        "type": "table",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "columns": [cell(c, True) for c in header],
        "rows": [[cell(v) for v in row] for row in rows],
        "decorative": False,
        "name": name,
        "max_columns": max_cols,
        "min_columns": 2,
        "max_rows": max_rows,
        "min_rows": 2,
    }


def group(name, w, h, children, x=None, y=None):
    el = {"type": "group", "size": {"width": w, "height": h}, "children": children, "name": name}
    if x is not None:
        el["position"] = {"x": x, "y": y}
    return el


def flex(name, x, y, w, h, direction, children, *, gap, max_children, min_children, align="flex-start"):
    return {
        "type": "flex",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "direction": direction,
        "align_items": align,
        "justify_content": "flex-start",
        "gap": gap,
        "children": children,
        "name": name,
        "max_children": max_children,
        "min_children": min_children,
    }


def grid(name, x, y, w, h, columns, children, *, gap, max_children, min_children, rows=None):
    el = {
        "type": "grid",
        "position": {"x": x, "y": y},
        "size": {"width": w, "height": h},
        "columns": columns,
        "column_gap": gap,
        "row_gap": gap,
        "children": children,
        "name": name,
        "max_children": max_children,
        "min_children": min_children,
    }
    if rows:
        el["rows"] = rows
    return el


def component(cid, description, elements, x=0, y=0):
    return {"id": cid, "description": description, "position": {"x": x, "y": y}, "elements": elements}


# ── shared chrome ─────────────────────────────────────────────────────────────


def chrome(t, *, dark_band=False):
    """Background plus the optional footer (Sibyl mark, slide number)."""
    comps = [component("background", "Full-slide background surface.", [rect(0, 0, W, H, t["bg"])])]
    if t["footer"]:
        m = t["margin"]
        footer = []
        if t["mark"]:
            footer.append({
                "type": "image",
                "position": {"x": m, "y": H - 40},
                "size": {"width": 16, "height": 16},
                "data": "static/sibyl-mark.png",
                "fit": "contain",
                "decorative": True,
                "name": "logo",
                "is_icon": False,
            })
        footer.append(text("page_number", W - m - 60, H - 41, 60, 18, t["scale"]["caption"], t["text3"], "1",
                           align="right", valign="middle", max_length=3, min_length=1))
        comps.append(component("footer", "Footer with the subtle Sibyl mark and the slide number.", footer))
    return comps


def header(t, sample_title, *, eyebrow=True, width=None):
    """Eyebrow label + slide title at the top of content slides."""
    s, m = t["scale"], t["margin"]
    w = width or (W - 2 * m)
    els = []
    y = 56
    if eyebrow:
        els.append(text("eyebrow", m, y, w, 20, s["caption"], t["accent"], "Overview", bold=True,
                        letter_spacing=1.2, max_length=32, min_length=3))
        y += 30
    title_h = int(s["title"] * 1.15 * 2)
    els.append(text("title", m, y, w, title_h, s["title"], t["ink"], sample_title, bold=True, lh=1.12))
    return component("header", "Slide eyebrow label and title (up to two lines).", els), y + title_h + 24


# ── layouts ───────────────────────────────────────────────────────────────────


def layouts_for(t):
    s, m = t["scale"], t["margin"]
    cw = W - 2 * m  # content width
    bottom = H - 64  # content must end above the footer
    L = []

    def add(lid, description, comps):
        L.append({"id": lid, "description": description, "components": chrome(t) + comps})

    # 1 title
    add("title_slide", "Opening title slide: large deck title, one-line subtitle and a presenter/date line. Use for the first slide.", [
        component("title_block", "Deck title, subtitle and presenter line, left aligned on the vertical centre.", [
            rect(m, 214, 56, 4, t["accent"]),
            text("title", m, 244, int(cw * 0.78), int(s["display"] * 1.08 * 2), s["display"], t["ink"],
                 "Clear thinking, beautifully presented", bold=True, lh=1.06),
            text("subtitle", m, 244 + int(s["display"] * 1.08 * 2) + 20, int(cw * 0.7), int(s["subtitle"] * 1.35 * 2),
                 s["subtitle"], t["text2"], "A short line that frames what this deck is about", lh=1.35),
            text("presenter", m, bottom - 30, int(cw * 0.6), 24, s["caption"] + 1, t["text3"],
                 "Presenter name · Date", max_length=48, min_length=4),
        ]),
    ])

    # 2 section divider
    add("section_divider", "Section divider between parts of the deck: section number, section title and one sentence.", [
        component("section_block", "Large section number, section title and a one-sentence description.", [
            text("section_number", m, 230, 200, int(s["display"] * 1.1), s["display"], t["accent"], "01",
                 bold=True, max_length=3, min_length=1, lh=1.0),
            text("section_title", m, 230 + int(s["display"] * 1.1) + 12, int(cw * 0.75), int(s["title"] * 1.15 * 2),
                 s["title"] + 6, t["ink"], "The section title goes here", bold=True, lh=1.1),
            text("section_description", m, 230 + int(s["display"] * 1.1) + 24 + int(s["title"] * 1.15 * 2),
                 int(cw * 0.6), int(s["body"] * 1.4 * 2), s["body"], t["text2"],
                 "One sentence on what this part covers.", lh=1.4),
        ]),
    ])

    # 3 agenda
    hdr, top = header(t, "Agenda")
    item_h = 64
    items = []
    for i in range(6):
        items.append(group("agenda_item", (cw - 24) // 2, item_h, [
            rect(0, 0, (cw - 24) // 2, item_h, t["surface"], t["radius"] // 2, t["border"]),
            text("item_number", 20, 18, 40, 28, s["subtitle"], t["accent"], f"{i + 1:02d}", bold=True,
                 max_length=2, min_length=1, valign="middle"),
            text("item_title", 72, 12, (cw - 24) // 2 - 92, 40, s["body"], t["ink"], "Agenda topic",
                 valign="middle", lh=1.2),
        ]))
    add("agenda", "Agenda or table of contents: 3 to 6 numbered topics in two columns.", [hdr, component(
        "agenda_items", "Numbered agenda topics in a two-column grid.",
        [grid("agenda_items", m, top + 8, cw, 3 * item_h + 2 * 16, 2, items[:6], gap=16, max_children=6, min_children=3)])])

    # 4 bullets
    hdr, top = header(t, "Key points, stated plainly")
    add("text_bullets", "Text with bullets: a lead sentence and 3 to 5 concise bullet points.", [hdr, component(
        "body", "Lead sentence and bullet list.", [
            text("lead", m, top, int(cw * 0.8), int(s["subtitle"] * 1.35 * 2), s["subtitle"], t["text2"],
                 "One sentence that sets up the points below.", lh=1.35),
            bullets("points", m, top + int(s["subtitle"] * 1.35 * 2) + 24, int(cw * 0.8),
                    bottom - top - int(s["subtitle"] * 1.35 * 2) - 24, s["body"] + 1, t["ink"],
                    ["First point, short and specific", "Second point with a concrete detail", "Third point that lands the idea"],
                    max_items=5, min_items=3),
        ])])

    # 5 two columns
    hdr, top = header(t, "Two sides of the topic")
    col_w = (cw - 48) // 2
    cols = []
    for side, x in (("left", m), ("right", m + col_w + 48)):
        cols += [
            rect(x, top, 40, 3, t["accent"]),
            text(f"{side}_heading", x, top + 18, col_w, int(s["subtitle"] * 1.25 * 2), s["subtitle"], t["ink"],
                 "Column heading", bold=True, lh=1.25),
            bullets(f"{side}_points", x, top + 18 + int(s["subtitle"] * 1.25 * 2) + 16, col_w,
                    bottom - top - 18 - int(s["subtitle"] * 1.25 * 2) - 16, s["body"], t["text2"],
                    ["A supporting point", "Another supporting point", "A third detail"], max_items=4, min_items=2),
        ]
    add("two_column", "Two columns, each with a heading and 2 to 4 bullets. Use for two related topics or before/after.",
        [hdr, component("columns", "Two equal columns with heading and bullets.", cols)])

    # 6 image + text
    img_w = int(W * 0.42)
    tw = W - img_w - m - 56
    add("image_text", "Image with text: a photo on the right, title, paragraph and up to 3 bullets on the left. Use when a picture helps.", [
        component("image_panel", "Full-height image on the right, cropped to fill.", [
            image("image", W - img_w, 0, img_w, H, 0, "A calm, editorial photograph related to the slide topic"),
        ]),
        component("text_panel", "Title, paragraph and bullets on the left.", [
            text("eyebrow", m, 72, tw, 20, s["caption"], t["accent"], "Context", bold=True, letter_spacing=1.2,
                 max_length=28, min_length=3),
            text("title", m, 102, tw, int(s["title"] * 1.12 * 3), s["title"], t["ink"], "A picture and the point it makes",
                 bold=True, lh=1.12),
            text("body", m, 102 + int(s["title"] * 1.12 * 3) + 20, tw, int(s["body"] * 1.45 * 4), s["body"], t["text2"],
                 "A short paragraph explaining what the image shows and why it matters.", lh=1.45),
            bullets("points", m, 102 + int(s["title"] * 1.12 * 3) + 40 + int(s["body"] * 1.45 * 4), tw,
                    bottom - (102 + int(s["title"] * 1.12 * 3) + 40 + int(s["body"] * 1.45 * 4)), s["body"], t["ink"],
                    ["A supporting detail", "Another detail"], max_items=3, min_items=0),
        ]),
    ])

    # 7 KPI row
    hdr, top = header(t, "The numbers that matter")
    card_h = 210
    kw = (cw - 3 * 20) // 4
    cards = []
    for i in range(4):
        cards.append(group("kpi", kw, card_h, [
            rect(0, 0, kw, card_h, t["surface"], t["radius"], t["border"]),
            text("kpi_value", 24, 28, kw - 40, int(s["kpi"] * 1.1), s["kpi"], t["ink"], ["42%", "3.1x", "$1.2M", "18"][i],
                 bold=True, max_length=7, min_length=1, lh=1.05),
            text("kpi_label", 24, 40 + int(s["kpi"] * 1.1), kw - 48, int(s["body"] * 1.3 * 2), s["body"], t["ink"],
                 "What it measures", bold=True, lh=1.3),
            text("kpi_note", 24, 52 + int(s["kpi"] * 1.1) + int(s["body"] * 1.3 * 2), kw - 48, int(s["caption"] * 1.4 * 3),
                 s["caption"] + 1, t["text2"], "Short context for the number", lh=1.4),
        ]))
    add("kpi_row", "Key metrics: 2 to 4 KPI cards, each with a big value, a label and a short note. Use for headline numbers.",
        [hdr, component("kpis", "Row of equal KPI cards on a shared baseline.",
                        [grid("kpis", m, top + 12, cw, card_h, 4, cards, gap=20, max_children=4, min_children=2, rows=1)]),
         component("summary", "One-line takeaway under the KPI cards.", [
             text("takeaway", m, top + 12 + card_h + 28, int(cw * 0.8), int(s["body"] * 1.4 * 2), s["body"], t["text2"],
                  "One sentence on what these numbers mean together.", lh=1.4)])])

    # 8 bar chart
    hdr, top = header(t, "Comparison across categories")
    chart_w = int(cw * 0.64)
    add("chart_bar", "Bar chart with a takeaway: categories compared on one or two series, with a short explanation on the right.", [
        hdr,
        component("chart", "Bar chart sized to its panel.", [
            chart("chart", m, top, chart_w, bottom - top, "bar", t, ["Q1", "Q2", "Q3", "Q4"],
                  [{"name": "This year", "values": [12, 18, 22, 27]}, {"name": "Last year", "values": [10, 13, 17, 20]}])]),
        component("insight", "Takeaway heading and explanation beside the chart.", [
            text("insight_heading", m + chart_w + 40, top + 8, cw - chart_w - 40, int(s["subtitle"] * 1.25 * 3),
                 s["subtitle"], t["ink"], "What the chart shows", bold=True, lh=1.25),
            text("insight_body", m + chart_w + 40, top + 24 + int(s["subtitle"] * 1.25 * 3), cw - chart_w - 40,
                 bottom - top - 24 - int(s["subtitle"] * 1.25 * 3), s["body"], t["text2"],
                 "Two or three sentences that explain the trend and why it matters.", lh=1.45),
        ]),
    ])

    # 9 line chart
    hdr, top = header(t, "Trend over time")
    add("chart_line", "Line chart across the full width for a trend over time, with a one-line caption.", [
        hdr,
        component("chart", "Wide line chart.", [
            chart("chart", m, top, cw, bottom - top - 40, "line", t, ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
                  [{"name": "Series A", "values": [10, 14, 13, 18, 22, 26]}, {"name": "Series B", "values": [8, 9, 12, 12, 15, 17]}])]),
        component("caption", "Caption under the chart.", [
            text("caption", m, bottom - 28, cw, 24, s["caption"] + 1, t["text3"], "Source or one-line caption",
                 valign="middle")]),
    ])

    # 10 donut chart
    hdr, top = header(t, "How the whole breaks down")
    add("chart_pie", "Donut chart for parts of a whole (3 to 6 slices), with a takeaway on the left.", [
        hdr,
        component("insight", "Takeaway on the left.", [
            text("insight_heading", m, top + 8, int(cw * 0.36), int(s["subtitle"] * 1.25 * 3), s["subtitle"], t["ink"],
                 "The biggest share", bold=True, lh=1.25),
            text("insight_body", m, top + 24 + int(s["subtitle"] * 1.25 * 3), int(cw * 0.36),
                 bottom - top - 24 - int(s["subtitle"] * 1.25 * 3), s["body"], t["text2"],
                 "Explain the split and what it implies.", lh=1.45),
        ]),
        component("chart", "Donut chart.", [
            chart("chart", m + int(cw * 0.42), top, cw - int(cw * 0.42), bottom - top, "donut", t,
                  ["Segment A", "Segment B", "Segment C", "Other"], [{"name": "Share", "values": [42, 28, 18, 12]}])]),
    ])

    # 11 table
    hdr, top = header(t, "Side-by-side details")
    add("table", "Table of text data: up to 6 rows and 4 columns with a header row. Use only when the content is tabular.", [
        hdr,
        component("table", "Data table sized to the content area.", [
            table("table", m, top, cw, bottom - top, t, ["Item", "Detail", "Owner", "Status"],
                  [["Row one", "A short detail", "Team", "Done"], ["Row two", "A short detail", "Team", "In progress"],
                   ["Row three", "A short detail", "Team", "Planned"]])]),
    ])

    # 12 timeline / process
    hdr, top = header(t, "How it unfolds")
    step_w = (cw - 4 * 16) // 5
    steps = []
    for i in range(5):
        steps.append(group("step", step_w, 260, [
            ellipse(0, 0, 18, t["accent"]),
            text("step_label", 0, 34, step_w - 16, 20, s["caption"], t["accent"], f"Step {i + 1}", bold=True,
                 letter_spacing=0.8, max_length=18, min_length=2),
            text("step_title", 0, 60, step_w - 16, int(s["body"] * 1.25 * 2), s["body"] + 1, t["ink"], "Milestone",
                 bold=True, lh=1.25),
            text("step_description", 0, 70 + int(s["body"] * 1.25 * 2), step_w - 16, int(s["caption"] * 1.45 * 5),
                 s["caption"] + 1, t["text2"], "What happens at this stage.", lh=1.45),
        ]))
    add("timeline", "Timeline or process: 3 to 5 sequential steps left to right, each with a label, title and description.", [
        hdr,
        component("rail", "Thin connecting line behind the step markers.", [rect(m, top + 40 + 8, cw, 2, t["border"])]),
        component("steps", "Evenly spaced steps.", [
            grid("steps", m, top + 40, cw, 260, 5, steps, gap=16, max_children=5, min_children=3, rows=1)]),
    ])

    # 13 comparison
    hdr, top = header(t, "Option A versus option B")
    card_w = (cw - 32) // 2
    comp_els = []
    for side, x, fill, fg, sub in (("left", m, t["surface"], t["ink"], t["text2"]),
                                   ("right", m + card_w + 32, t["ink"], t["on_ink"], t["on_ink"])):
        comp_els += [
            rect(x, top, card_w, bottom - top, fill, t["radius"], t["border"] if side == "left" else None),
            text(f"{side}_label", x + 32, top + 28, card_w - 64, 20, s["caption"], sub, "Option", bold=True,
                 letter_spacing=1.2, max_length=24, min_length=2),
            text(f"{side}_heading", x + 32, top + 56, card_w - 64, int(s["subtitle"] * 1.25 * 2), s["subtitle"], fg,
                 "Heading for this side", bold=True, lh=1.25),
            bullets(f"{side}_points", x + 32, top + 72 + int(s["subtitle"] * 1.25 * 2), card_w - 64,
                    bottom - top - 104 - int(s["subtitle"] * 1.25 * 2), s["body"], fg,
                    ["A difference", "Another difference", "A third difference"], max_items=4, min_items=2),
        ]
    add("comparison", "Comparison of two options or before/after: two cards with a label, heading and 2 to 4 bullets each.",
        [hdr, component("comparison", "Two contrasting cards side by side.", comp_els)])

    # 14 quote
    add("quote", "Quote or key statement: one large quotation with the speaker's name and role.", [
        component("quote", "Large quotation mark, quote and attribution.", [
            text("quote_mark", m, 120, 80, 90, 96, t["accent"], "“", bold=True, decorative=True, max_length=1,
                 min_length=1, lh=1.0),
            text("quote", m, 220, int(cw * 0.86), int(s["title"] * 1.25 * 4), s["title"], t["ink"],
                 "A memorable line that captures the idea of this deck.", lh=1.25),
            rect(m, 240 + int(s["title"] * 1.25 * 4), 40, 2, t["accent"]),
            text("attribution", m, 256 + int(s["title"] * 1.25 * 4), int(cw * 0.6), 26, s["body"], t["ink"],
                 "Name", bold=True, max_length=40, min_length=2),
            text("attribution_role", m, 286 + int(s["title"] * 1.25 * 4), int(cw * 0.6), 24, s["caption"] + 1,
                 t["text2"], "Role, organisation", max_length=56, min_length=2),
        ]),
    ])

    # 15 team / people
    hdr, top = header(t, "The people behind it")
    people = []
    for _ in range(4):
        pw = (cw - 3 * 24) // 4
        people.append(group("person", pw, 280, [
            image("photo", 0, 0, 120, 120, 60, "Professional headshot portrait, neutral background"),
            text("person_name", 0, 140, pw - 4, 28, s["body"] + 1, t["ink"], "Full name", bold=True, max_length=28,
                 min_length=2),
            text("person_role", 0, 172, pw - 4, 22, s["caption"] + 1, t["accent"], "Role", max_length=32, min_length=2),
            text("person_bio", 0, 202, pw - 4, int(s["caption"] * 1.45 * 4), s["caption"] + 1, t["text2"],
                 "One line about their focus.", lh=1.45),
        ]))
    add("team", "Team or people: 2 to 4 people with photo, name, role and one-line bio.", [
        hdr, component("people", "Grid of people cards.", [
            grid("people", m, top + 8, cw, 280, 4, people, gap=24, max_children=4, min_children=2, rows=1)])])

    # 16 closing
    add("closing", "Closing or call to action: a short headline, one supporting line and a contact or next-step line. Use for the last slide.", [
        component("closing_block", "Centered closing message with call to action.", [
            text("headline", m + 80, 230, cw - 160, int(s["display"] * 1.1 * 2), s["display"], t["ink"],
                 "Thank you", bold=True, align="center", lh=1.08),
            text("subtitle", m + 140, 250 + int(s["display"] * 1.1 * 2), cw - 280, int(s["subtitle"] * 1.35 * 2),
                 s["subtitle"], t["text2"], "The one thing to remember, or the next step.", align="center", lh=1.35),
            text("contact", m + 140, 290 + int(s["display"] * 1.1 * 2) + int(s["subtitle"] * 1.35 * 2), cw - 280, 26,
                 s["body"], t["accent"], "name@example.com", align="center", bold=True, max_length=48, min_length=3),
        ]),
    ])
    return L


def theme_for(t):
    colors = {
        "primary": t["accent"], "background": t["bg"], "card": t["surface"], "stroke": t["border"],
        "primary_text": t["on_ink"], "background_text": t["ink"],
    }
    palette = (t["chart"] + [t["text2"], t["text3"], t["border"], t["subtle"]])[:10]
    for i, c in enumerate(palette):
        colors[f"graph_{i}"] = c
    return {"colors": colors, "fonts": {"textFont": {"name": FONT, "url": "static/Inter[opsz,wght].ttf"}}}


def write_assets(family, t, out: Path):
    static = out / "static"
    static.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(INTER, static / "Inter[opsz,wght].ttf")
    from PIL import Image, ImageDraw, ImageFont  # pillow (engine dependency)

    def hex_rgb(h):
        h = h.lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

    mask = Image.open(MARK_MASK).convert("RGBA")
    alpha = mask.split()[3]
    tinted = Image.new("RGBA", mask.size, hex_rgb(t["text3"]) + (255,))
    tinted.putalpha(alpha)
    tinted.thumbnail((128, 128))
    tinted.save(static / "sibyl-mark.png")

    # Thumbnail: the title slide in miniature (640x360).
    thumb = Image.new("RGB", (640, 360), hex_rgb(t["bg"]))
    d = ImageDraw.Draw(thumb)
    sc = 0.5
    m = t["margin"] * sc
    try:
        big = ImageFont.truetype(str(INTER), int(t["scale"]["display"] * sc * 0.9))
        big.set_variation_by_axes([14, 700]) if hasattr(big, "set_variation_by_axes") else None
        small = ImageFont.truetype(str(INTER), int(t["scale"]["subtitle"] * sc))
        cap = ImageFont.truetype(str(INTER), 10)
    except Exception:
        big = small = cap = ImageFont.load_default()
    d.rectangle([m, 104, m + 28, 106], fill=hex_rgb(t["accent"]))
    d.text((m, 118), t["name"].replace("Sibyl ", ""), font=big, fill=hex_rgb(t["ink"]))
    d.text((m, 118 + t["scale"]["display"] * sc + 14), "Clear thinking, beautifully presented",
           font=small, fill=hex_rgb(t["text2"]))
    # mini KPI cards
    cw = (640 - 2 * m - 24) / 3
    for i in range(3):
        x = m + i * (cw + 12)
        d.rounded_rectangle([x, 250, x + cw, 310], radius=6, fill=hex_rgb(t["surface"]), outline=hex_rgb(t["border"]))
        d.rectangle([x + 10, 262, x + 10 + cw * 0.4, 276], fill=hex_rgb(t["chart"][i % len(t["chart"])]))
        d.rectangle([x + 10, 284, x + cw - 20, 288], fill=hex_rgb(t["border"]))
    if t["mark"]:
        mk = tinted.copy()
        mk.thumbnail((10, 10))
        thumb.paste(mk, (int(m), 340), mk)
    thumb.save(static / "thumbnail.png")


def main():
    for family, t in FAMILIES.items():
        out = ROOT / family
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        write_assets(family, t, out)
        doc = {
            "id": family,
            "name": t["name"],
            "description": t["description"],
            "thumbnail": "static/thumbnail.png",
            "layouts": layouts_for(t),
            "fonts": {FONT: "static/Inter[opsz,wght].ttf"},
            "theme": theme_for(t),
        }
        (out / "template.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
        print(f"{family}: {len(doc['layouts'])} layouts")


if __name__ == "__main__":
    main()
