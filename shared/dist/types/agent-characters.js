import { AGENT_LOOK_STYLES, parseAgentLook } from "./agent-look.js";
export const BRAND_LOOK_COLOR = "#e74e3c";
export const DEFAULT_AGENT_LOOK = { style: "octo", color: BRAND_LOOK_COLOR };
export const LOOK_COLORS = [
    { name: "Coral", value: BRAND_LOOK_COLOR },
    { name: "Ocean", value: "#0ea5e9" },
    { name: "Sunflower", value: "#f5b301" },
    { name: "Orchid", value: "#c026d3" },
    { name: "Lime", value: "#65a30d" },
    { name: "Berry", value: "#db2777" },
    { name: "Slate", value: "#475569" },
];
export const CHARACTER_NAMES = {
    octo: "Octo",
    blob: "Blob",
    droplet: "Droplet",
    ghost: "Ghost",
    star: "Star",
    kit: "Kit",
};
export const CHARACTER_STYLES = AGENT_LOOK_STYLES;
export const OCTO_MASCOT = {
    viewBox: "0 0 512 512",
    bodyPath: "M150.25 19.97c-114.48-.574-139.972 184.95 20.563 212.124c-29.5.534-55.382 8.11-91.75 25.97C-19.2 306.313.665 462.966 100.874 446c34.48-5.838 51.21-50.325.875-65.375c16.515 29.61-27.968 47.1-41.906 1.938c-11.262-36.49 21.145-74.914 52.468-85c30.5-9.82 55.244-10.86 82.47-5.844c-36.585 34.247-56.547 80.465-42.376 123.624c44.522 135.595 192.146 82.52 162.844-6.72c-10.346-31.506-41.408-46.505-68-10.155c35.164-8.854 50.45 38.75 18.188 49.342c-26.355 8.655-60.212-13.527-66.032-41.343c-7.82-37.39 19.77-77.195 54.78-95.25c22.176 35.37 38.812 48.68 83.22 72.186c85.843 45.436 212.957-36.54 143.906-110.53c-22.626-24.244-54.574-30.02-67.5 13.124c30.188-20.09 60.748 26.8 33.875 47.563c-21.95 16.96-61.503 19.135-86.437 5.5c-30.797-16.842-53.79-37.798-70.188-66.532c57.07 13.69 119.584-1.065 143-45.342c45.72-86.45-7.046-152.467-59.125-153.375c-20.378-.356-40.654 9.237-54.875 31.5c-17.85 27.946-9.815 61.533 35.157 59.124c-29.11-21.628-1.9-63.623 26.717-45.343c23.378 14.932 22.494 51.88 9.75 77.28c-15.165 30.23-60.573 50.738-95.062 24.657c-3.008-5.71-5.563-11.683-7.78-17.843c8.99-6.49 14.874-17.028 14.874-28.875c0-17.772-13.252-32.64-30.345-35.218c-9.763-47.134-23.34-92.648-84.844-112.594c-13.64-4.424-26.437-6.472-38.28-6.53z",
    eyeCircles: [
        "<circle cx=\"268\" cy=\"157\" r=\"22\" fill=\"white\" stroke=\"#333\" stroke-width=\"2.5\"></circle>",
        "<circle cx=\"274\" cy=\"152\" r=\"11\" fill=\"#111\"></circle>",
        "<circle cx=\"277\" cy=\"149\" r=\"4\" fill=\"white\"></circle>",
        "<circle cx=\"203\" cy=\"168\" r=\"22\" fill=\"white\" stroke=\"#333\" stroke-width=\"2.5\"></circle>",
        "<circle cx=\"209\" cy=\"163\" r=\"11\" fill=\"#111\"></circle>",
        "<circle cx=\"212\" cy=\"160\" r=\"4\" fill=\"white\"></circle>",
    ],
};
const INK = "#333";
function eye(cx, cy, r) {
    const n = (value) => Number(value.toFixed(2));
    return `<g data-part="eye">`
        + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${INK}" stroke-width="${n(r * 0.11)}"/>`
        + `<g data-part="pupil"><circle cx="${n(cx + r * 0.27)}" cy="${n(cy - r * 0.23)}" r="${n(r * 0.5)}" fill="#111"/>`
        + `<circle cx="${n(cx + r * 0.41)}" cy="${n(cy - r * 0.36)}" r="${n(r * 0.18)}" fill="#fff"/></g>`
        + `</g>`;
}
function mouthShape(kind, { x, y, w, stroke, catSmile }) {
    const line = (d) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${stroke}" stroke-linecap="round"/>`;
    switch (kind) {
        case "smile":
            return catSmile
                ? line(`M${x} ${y}Q${x - w * 0.9} ${y + w * 1.1} ${x - w * 1.7} ${y + w * 0.4}M${x} ${y}Q${x + w * 0.9} ${y + w * 1.1} ${x + w * 1.7} ${y + w * 0.4}`)
                : line(`M${x - w} ${y}Q${x} ${y + w * 0.9} ${x + w} ${y}`);
        case "oh":
            return `<ellipse cx="${x}" cy="${y + w * 0.5}" rx="${w * 0.6}" ry="${w * 0.78}" fill="${INK}"/>`;
        case "hmm":
            return line(`M${x - w * 0.7} ${y + w * 0.35}L${x + w * 0.7} ${y - w * 0.15}`);
        case "line":
            return line(`M${x - w * 0.6} ${y + w * 0.1}L${x + w * 0.6} ${y + w * 0.1}`);
        case "grin":
            return `<path d="M${x - w} ${y}Q${x} ${y + w * 1.5} ${x + w} ${y}Z" fill="${INK}"/>`;
    }
}
function mouth(x, y, w, rest = "smile", catSmile = false) {
    const stroke = Number((2.2 * w / 6).toFixed(2));
    const kinds = ["smile", "oh", "hmm", "line", "grin"];
    return `<g data-part="mouth" data-rest="${rest}">` + kinds.map((kind) => `<g data-mouth="${kind}"${kind === rest ? "" : " display=\"none\""}>${mouthShape(kind, { x, y, w, stroke, catSmile })}</g>`).join("") + `</g>`;
}
function arms(color, cy, inset) {
    const arm = (side, cx, tilt) => `<g data-part="arm-${side}"><ellipse cx="${cx}" cy="${cy}" rx="9" ry="5" transform="rotate(${tilt} ${cx} ${cy})" fill="${color}"/></g>`;
    return arm("l", inset, -28) + arm("r", 100 - inset, 28);
}
function figure(viewBox, parts) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`
        + `<g data-part="body">${parts.body}</g>`
        + (parts.arms ?? "")
        + `<g data-part="face">${parts.face}</g>`
        + `</svg>`;
}
function octo(color) {
    const circles = OCTO_MASCOT.eyeCircles;
    const mascotEye = ([sclera, pupil, glint]) => `<g data-part="eye">${sclera}<g data-part="pupil">${pupil}${glint}</g></g>`;
    return figure(OCTO_MASCOT.viewBox, {
        body: `<path fill="${color}" d="${OCTO_MASCOT.bodyPath}"/>`,
        face: mascotEye(circles.slice(0, 3)) + mascotEye(circles.slice(3, 6))
            + `<g transform="rotate(-10 236 203)">${mouth(236, 203, 13)}</g>`,
    });
}
const BOX = "0 0 100 100";
const STAR_POINTS = "50,10 61.8,35.8 90,38.6 69,58.2 75.4,86.6 50,72 24.6,86.6 31,58.2 10,38.6 38.2,35.8";
const DRAW = {
    octo,
    blob: (color) => figure(BOX, {
        arms: arms(color, 60, 13),
        body: `<path fill="${color}" d="M50 14C74 14 88 32 86 56C84 78 70 90 50 90C30 90 16 78 14 56C12 32 26 14 50 14Z"/>`
            + `<ellipse cx="38" cy="90" rx="9" ry="4.5" fill="${color}"/><ellipse cx="62" cy="90" rx="9" ry="4.5" fill="${color}"/>`,
        face: eye(39, 47, 9.5) + eye(61, 47, 9.5) + mouth(50, 63, 6),
    }),
    droplet: (color) => figure(BOX, {
        arms: arms(color, 68, 15),
        body: `<path fill="${color}" d="M50 7C58 24 84 44 84 62C84 80 69 93 50 93C31 93 16 80 16 62C16 44 42 24 50 7Z"/>`,
        face: eye(40, 60, 9) + eye(60, 60, 9) + mouth(50, 75, 5),
    }),
    ghost: (color) => figure(BOX, {
        arms: arms(color, 56, 13),
        body: `<path fill="${color}" d="M50 10C72 10 84 26 84 48L84 86Q77 93 70 86Q63 79 56.5 86Q50 93 43.5 86Q37 79 30 86Q23 93 16 86L16 48C16 26 28 10 50 10Z"/>`,
        face: eye(39, 44, 9.5) + eye(61, 44, 9.5) + mouth(50, 60, 6, "oh"),
    }),
    star: (color) => figure(BOX, {
        body: `<polygon points="${STAR_POINTS}" fill="${color}" stroke="${color}" stroke-width="9" stroke-linejoin="round"/>`,
        face: eye(41, 49, 7.5) + eye(59, 49, 7.5) + mouth(50, 61, 4.5),
    }),
    kit: (color) => figure(BOX, {
        arms: `<g data-part="arm-l"><ellipse cx="33" cy="88" rx="9" ry="5.5" fill="${color}"/></g>`
            + `<g data-part="arm-r"><ellipse cx="67" cy="88" rx="9" ry="5.5" fill="${color}"/></g>`,
        body: `<path fill="${color}" stroke="${color}" stroke-width="5" stroke-linejoin="round" d="M22 36L25 12L44 26Z"/>`
            + `<path fill="${color}" stroke="${color}" stroke-width="5" stroke-linejoin="round" d="M78 36L75 12L56 26Z"/>`
            + `<ellipse cx="50" cy="56" rx="36" ry="31" fill="${color}"/>`,
        face: eye(37, 53, 9) + eye(63, 53, 9)
            + `<path d="M47 64L53 64L50 67.5Z" fill="${INK}"/>`
            + mouth(50, 67.5, 4, "smile", true),
    }),
};
export function characterSvg(look) {
    const valid = parseAgentLook(look);
    if (!valid)
        throw new Error(`Not a drawable agent look: ${JSON.stringify(look)}`);
    return DRAW[valid.style](valid.color);
}
const FACE = /<g data-part="face">.*<\/g><\/svg>$/;
export function characterBackSvg(look) {
    const svg = characterSvg(look);
    if (!FACE.test(svg))
        throw new Error("Character markup no longer ends with its face");
    return svg.replace(FACE, "</svg>");
}
