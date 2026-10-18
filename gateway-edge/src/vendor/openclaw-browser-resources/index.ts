// @ts-nocheck
var vs = Object.create;
var Gt = Object.defineProperty;
var Cs = Object.getOwnPropertyDescriptor;
var Ts = Object.getOwnPropertyNames;
var Es = Object.getPrototypeOf, As = Object.prototype.hasOwnProperty;
var C = (e, t, n) => () => {
  if (n) throw n[0];
  try {
    return e && (t = e(e = 0)), t;
  } catch (o) {
    throw n = [o], o;
  }
};
var Hn = (e, t) => () => {
  try {
    return t || e((t = { exports: {} }).exports, t), t.exports;
  } catch (n) {
    throw t = 0, n;
  }
}, Ht = (e, t) => {
  for (var n in t)
    Gt(e, n, { get: t[n], enumerable: !0 });
}, _s = (e, t, n, o) => {
  if (t && typeof t == "object" || typeof t == "function")
    for (let r of Ts(t))
      !As.call(e, r) && r !== n && Gt(e, r, { get: () => t[r], enumerable: !(o = Cs(t, r)) || o.enumerable });
  return e;
};
var zn = (e, t, n) => (n = e != null ? vs(Es(e)) : {}, _s(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  t || !e || !e.__esModule ? Gt(n, "default", { value: e, enumerable: !0 }) : n,
  e
));

// openclaw/packages/normalization-core/src/record-coerce.ts
function V(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function G(e) {
  return V(e) ? e : void 0;
}
function L(e) {
  return V(e) ? e : null;
}
function zt(e) {
  return e && typeof e == "object" ? e : void 0;
}
function he(e) {
  return zt(e) ?? null;
}
var D = C(() => {
});

// openclaw/packages/normalization-core/src/string-coerce.ts
function H(e) {
  if (typeof e != "string")
    return null;
  let t = e.trim();
  return t || null;
}
function W(e) {
  return H(e) ?? void 0;
}
function O(e) {
  return typeof e == "string" && e.trim() ? e : void 0;
}
var F = C(() => {
});

// openclaw/packages/normalization-core/src/number-coercion.ts
function re(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
var Is, xu, oe = C(() => {
  F();
  Is = 2147e6, xu = Math.floor(Is / 1e3);
});

// openclaw/node_modules/.pnpm/@noble+ed25519@3.2.0/node_modules/@noble/ed25519/index.js
var Vn, Ie, Wt, rt, jt, $t, ot, Ps, Ds, qn, it, Ms, Yn, Zn, Jn, Os, ge, B, Wn, x, Ns, qt, Xn, ye, Be, me, Us, Fs, X, Ls, jn, Bs, Kt, Gs, $n, Kn, Hs, Qn = C(() => {
  Vn = Object.freeze, Ie = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn, Wt = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn, rt = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n, jt = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an, $t = 0x6666666666666666666666666666666666666666666666666666666666666658n, ot = Ie - 1n, Ps = Vn({
    p: Ie,
    n: Wt,
    h: 8n,
    a: ot,
    d: rt,
    Gx: jt,
    Gy: $t
  }), Ds = 32, qn = (e) => e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array" && e.BYTES_PER_ELEMENT === 1, it = (e, t, n = "") => {
    if (qn(e) && (t === void 0 || e.length === t))
      return e;
    let o = qn(e), r = t !== void 0 ? ` of length ${t}` : "", i = o ? `length=${e.length}` : `type=${typeof e}`, s = (n ? `"${n}" ` : "") + "expected Uint8Array" + r + ", got " + i;
    throw o ? new RangeError(s) : new TypeError(s);
  }, Ms = (e, t = "", n) => Uint8Array.from(it(e, n, t)), Yn = (e, t) => e.toString(16).padStart(t, "0"), Zn = (e) => {
    let t = "";
    for (let n of it(e))
      t += Yn(n, 2);
    return t;
  }, Jn = (e) => {
    let t = "hex invalid";
    if (typeof e != "string")
      throw new TypeError(t);
    if (e.length % 2 || !/^[\da-f]*$/i.test(e))
      throw new RangeError(t);
    let n = new Uint8Array(e.length / 2);
    for (let o = 0, r = 0; o < n.length; o++, r += 2) {
      let i = e.charCodeAt(r), s = e.charCodeAt(r + 1);
      n[o] = ((i & 15) + (i >> 6) * 9) * 16 + (s & 15) + (s >> 6) * 9;
    }
    return n;
  }, Os = (...e) => {
    let t = 0;
    for (let r of e)
      t += it(r).length;
    let n = new Uint8Array(t), o = 0;
    for (let r of e)
      n.set(r, o), o += r.length;
    return n;
  }, ge = (e, t, n, o = "bad number: out of range") => {
    if (typeof e != "bigint")
      throw new TypeError(o);
    if (t <= e && e < n)
      return e;
    throw new RangeError(o);
  }, B = (e, t = Ie) => (e %= t) >= 0n ? e : t + e, Wn = (1n << 255n) - 1n, x = (e) => {
    if (e < 0n)
      throw new RangeError("negative coordinate");
    let t = (e >> 255n) * 19n + (e & Wn);
    return t = (t >> 255n) * 19n + (t & Wn), t % Ie;
  }, Ns = (e, t) => {
    if (e === 0n)
      throw new Error("invert: expected non-zero number");
    if (t <= 1n)
      throw new Error("invert: expected modulus > 1, got " + t);
    let n = B(e, t), o = t, r = 0n, i = 1n;
    for (; n !== 0n; ) {
      let a = o / n, l = o - n * a, u = r - i * a;
      o = n, n = l, r = i, i = u;
    }
    if (o !== 1n)
      throw new Error("invert: does not exist");
    return B(r, t);
  }, qt = (e) => {
    if (e instanceof ye)
      return e;
    throw new TypeError("Point expected");
  }, Xn = 2n ** 256n, ye = class e {
    static BASE;
    static ZERO;
    X;
    Y;
    Z;
    T;
    // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
    // on-curve or that T matches X*Y/Z.
    constructor(t, n, o, r) {
      let i = Xn;
      this.X = ge(t, 0n, i), this.Y = ge(n, 0n, i), this.Z = ge(o, 1n, i), this.T = ge(r, 0n, i), Vn(this);
    }
    static CURVE() {
      return Ps;
    }
    static fromAffine(t) {
      return new e(t.x, t.y, 1n, x(t.x * t.y));
    }
    /** RFC8032 5.1.3: Uint8Array to Point. */
    static fromBytes(t, n = !1) {
      let o = Ms(t, "point", Ds), r = o[31];
      o[31] = r & -129;
      let i = Fs(o);
      n || ge(i, 0n, Ie);
      let s = x(i * i), a = B(s - 1n), l = x(rt * s + 1n), { isValid: u, value: h } = Bs(a, l);
      if (!u)
        throw new Error("bad point: y not sqrt");
      let p = !!(r & 128);
      if (!n && h === 0n && p)
        throw new Error("bad point: x==0, isLastByteOdd");
      return p !== !!(h & 1n) && (h = B(-h)), new e(h, i, 1n, x(h * i));
    }
    static fromHex(t, n) {
      return e.fromBytes(Jn(t), n);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /** Checks if the point is valid and on-curve. */
    assertValidity() {
      let t = ot, n = rt, o = this;
      if (o.is0())
        throw new Error("bad point: ZERO");
      let { X: r, Y: i, Z: s, T: a } = o, l = x(r * r), u = x(i * i), h = x(s * s), p = x(h * h), g = x(l * t), c = x(h * (g + u)), d = B(p + x(n * x(l * u)));
      if (c !== d)
        throw new Error("bad point: equation left != right (1)");
      let m = x(r * i), f = x(s * a);
      if (m !== f)
        throw new Error("bad point: equation left != right (2)");
      return this;
    }
    /** Equality check: compare points P&Q. */
    equals(t) {
      let { X: n, Y: o, Z: r } = this, { X: i, Y: s, Z: a } = qt(t);
      return x(n * a) === x(i * r) && x(o * a) === x(s * r);
    }
    is0() {
      return this.equals(me);
    }
    /** Flip point over y coordinate. */
    negate() {
      return new e(B(-this.X), this.Y, this.Z, B(-this.T));
    }
    /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
    double() {
      let { X: t, Y: n, Z: o } = this, r = ot, i = x(t * t), s = x(n * n), a = x(2n * o * o), l = x(r * i), u = B(t + n), h = B(x(u * u) - i - s), p = B(l + s), g = B(p - a), c = B(l - s), d = x(h * g), m = x(p * c), f = x(h * c), y = x(g * p);
      return new e(d, m, y, f);
    }
    /** Point addition. Complete formula. Cost: `9M + 1*a + 1*d + 7add`. */
    add(t) {
      let { X: n, Y: o, Z: r, T: i } = this, { X: s, Y: a, Z: l, T: u } = qt(t), h = ot, p = rt, g = x(n * s), c = x(o * a), d = x(x(i * p) * u), m = x(r * l), f = B(x(B(n + o) * B(s + a)) - g - c), y = B(m - d), w = B(m + d), b = B(c - x(h * g)), S = x(f * y), k = x(w * b), R = x(f * b), I = x(y * w);
      return new e(S, k, I, R);
    }
    subtract(t) {
      return this.add(qt(t).negate());
    }
    /**
     * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
     * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
     * Uses {@link wNAF} for base point.
     * Uses fake point to mitigate side-channel leakage.
     * @param n - scalar by which point is multiplied
     * @param safe - safe mode guards against timing attacks; unsafe mode is faster
     */
    multiply(t, n = !0) {
      if (!n && t === 0n || (ge(t, 1n, Wt), !n && this.is0()))
        return me;
      if (t === 1n)
        return this;
      if (this.equals(Be))
        return Hs(t).p;
      let o = me, r = Be, i = this;
      for (let s = 0; n ? s < 256 : t > 0n; s++)
        t & 1n ? o = o.add(i) : n && (r = r.add(i)), i = i.double(), t >>= 1n;
      return o;
    }
    multiplyUnsafe(t) {
      return this.multiply(t, !1);
    }
    /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
    toAffine() {
      let { X: t, Y: n, Z: o } = this;
      if (this.equals(me))
        return { x: 0n, y: 1n };
      let r = Ns(o, Ie);
      if (x(o * r) !== 1n)
        throw new Error("invalid inverse");
      return { x: x(t * r), y: x(n * r) };
    }
    toBytes() {
      let { x: t, y: n } = this.toAffine(), o = Us(n);
      return o[31] |= t & 1n ? 128 : 0, o;
    }
    toHex() {
      return Zn(this.toBytes());
    }
    clearCofactor() {
      return this.multiply(8n, !1);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      return this.multiply(Wt / 2n, !1).double().add(this).is0();
    }
  }, Be = new ye(jt, $t, 1n, B(jt * $t)), me = new ye(0n, 1n, 1n, 0n);
  ye.BASE = Be;
  ye.ZERO = me;
  Us = (e) => Jn(Yn(ge(e, 0n, Xn), 64)).reverse(), Fs = (e) => BigInt("0x" + Zn(Uint8Array.from(it(e)).reverse())), X = (e, t) => {
    let n = e;
    for (; t-- > 0; )
      n = x(n * n);
    return n;
  }, Ls = (e) => {
    let t = x(e * e), n = x(t * e), o = x(X(n, 2) * n), r = x(X(o, 1) * e), i = x(X(r, 5) * r), s = x(X(i, 10) * i), a = x(X(s, 20) * s), l = x(X(a, 40) * a), u = x(X(l, 80) * l), h = x(X(u, 80) * l), p = x(X(h, 10) * i);
    return x(X(p, 2) * e);
  }, jn = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, Bs = (e, t) => {
    let n = x(t * x(t * t)), o = x(x(n * n) * t), r = Ls(x(e * o)), i = x(e * x(n * r)), s = x(t * x(i * i)), a = i, l = x(i * jn), u = s === e, h = s === B(-e), p = s === B(-e * jn);
    return u && (i = a), (h || p) && (i = l), (B(i) & 1n) === 1n && (i = B(-i)), { isValid: u || h, value: i };
  }, Kt = {
    sha512Async: async (e) => {
      let t = globalThis?.crypto?.subtle;
      if (!t)
        throw new Error("crypto.subtle must be defined, consider polyfill");
      return new Uint8Array(await t.digest("SHA-512", Os(e)));
    },
    sha512: void 0
  }, Gs = () => {
    let e = [], t = Be, n;
    for (let o = 0; o < 33; o++) {
      n = t, e.push(n);
      for (let r = 1; r < 128; r++)
        n = n.add(t), e.push(n);
      t = n.double();
    }
    return e;
  }, Kn = (e, t) => {
    let n = t.negate();
    return e ? n : t;
  }, Hs = (e) => {
    let t = $n || ($n = Gs()), n = me, o = Be;
    for (let r = 0; r < 33; r++) {
      let i = Number(e & 255n);
      e >>= 8n, i > 128 && (i -= 256, e += 1n);
      let s = r * 128, a = s + Math.abs(i) - 1, l = r % 2 !== 0, u = i < 0;
      i === 0 ? o = o.add(Kn(l, t[s])) : n = n.add(Kn(u, t[a]));
    }
    if (e !== 0n)
      throw new Error("invalid wnaf");
    return { p: n, f: o };
  };
});

// openclaw/packages/gateway-client/src/device-auth.ts
var er = C(() => {
});

// openclaw/packages/gateway-client/src/chat-stream-message.ts
var tr = C(() => {
  D();
});

// openclaw/packages/gateway-client/src/chat-stream-projection.ts
var nr = C(() => {
  D();
});

// openclaw/packages/normalization-core/src/string-normalization.ts
var st = C(() => {
  F();
});

// openclaw/packages/gateway-protocol/src/connect-error-details.ts
var P, Fu, Lu, Vt = C(() => {
  oe();
  st();
  P = {
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
    AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
    AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
    AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
    AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
    // pragma: allowlist secret
    AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
    // pragma: allowlist secret
    AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED",
    // pragma: allowlist secret
    AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
    AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
    AUTH_SCOPE_MISMATCH: "AUTH_SCOPE_MISMATCH",
    AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
    AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
    AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
    AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
    AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
    AUTH_IDENTITY_HEADER_REQUIRED: "AUTH_IDENTITY_HEADER_REQUIRED",
    AUTH_VERIFIED_USER_REQUIRED: "AUTH_VERIFIED_USER_REQUIRED",
    AUTHENTICATED_PROFILE_UNAVAILABLE: "AUTHENTICATED_PROFILE_UNAVAILABLE",
    OPERATOR_ACCESS_DENIED: "OPERATOR_ACCESS_DENIED",
    CONTROL_UI_BUILD_MISMATCH: "CONTROL_UI_BUILD_MISMATCH",
    CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
    PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
    CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
    DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
    DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
    DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
    DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
    DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
    DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
    DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
    PAIRING_REQUIRED: "PAIRING_REQUIRED",
    PAIRING_REJECTED: "PAIRING_REJECTED",
    PAIRING_EXPIRED: "PAIRING_EXPIRED",
    CLIENT_VERSION_MISMATCH: "CLIENT_VERSION_MISMATCH"
  }, Fu = /* @__PURE__ */ new Map([
    ["token_missing", P.AUTH_TOKEN_MISSING],
    ["token_mismatch", P.AUTH_TOKEN_MISMATCH],
    ["token_missing_config", P.AUTH_TOKEN_NOT_CONFIGURED],
    ["password_missing", P.AUTH_PASSWORD_MISSING],
    ["password_mismatch", P.AUTH_PASSWORD_MISMATCH],
    ["password_missing_config", P.AUTH_PASSWORD_NOT_CONFIGURED],
    ["bootstrap_token_invalid", P.AUTH_BOOTSTRAP_TOKEN_INVALID],
    ["tailscale_user_missing", P.AUTH_TAILSCALE_IDENTITY_MISSING],
    ["tailscale_proxy_missing", P.AUTH_TAILSCALE_PROXY_MISSING],
    ["tailscale_whois_failed", P.AUTH_TAILSCALE_WHOIS_FAILED],
    ["tailscale_user_mismatch", P.AUTH_TAILSCALE_IDENTITY_MISMATCH],
    ["rate_limited", P.AUTH_RATE_LIMITED],
    ["device_token_mismatch", P.AUTH_DEVICE_TOKEN_MISMATCH],
    ["scope_mismatch", P.AUTH_SCOPE_MISMATCH],
    [void 0, P.AUTH_REQUIRED]
  ]), Lu = /* @__PURE__ */ new Map([
    ["device-id-mismatch", P.DEVICE_AUTH_DEVICE_ID_MISMATCH],
    ["device-signature-stale", P.DEVICE_AUTH_SIGNATURE_EXPIRED],
    ["device-nonce-missing", P.DEVICE_AUTH_NONCE_REQUIRED],
    ["device-nonce-mismatch", P.DEVICE_AUTH_NONCE_MISMATCH],
    ["device-signature", P.DEVICE_AUTH_SIGNATURE_INVALID],
    ["device-public-key", P.DEVICE_AUTH_PUBLIC_KEY_INVALID]
  ]);
});

// openclaw/packages/gateway-client/src/connect-auth.ts
var rr = C(() => {
  F();
});

// openclaw/packages/gateway-client/src/browser-device-auth.ts
var or = C(() => {
});

// openclaw/packages/gateway-client/src/gateway-origin-scope.ts
var ir = C(() => {
});

// openclaw/packages/gateway-client/src/model-catalog-connect.ts
var sr = C(() => {
});

// openclaw/packages/retry/src/index.ts
function at(e, t, n, o) {
  return typeof e != "number" || !Number.isFinite(e) ? t : Math.min(
    Math.max(e, n ?? Number.NEGATIVE_INFINITY),
    o ?? Number.POSITIVE_INFINITY
  );
}
function Ws(e, t) {
  return Math.max(1, Math.round(at(e, t)));
}
function Ge(e) {
  let t = e === Number.POSITIVE_INFINITY ? 2147e6 : Number.isFinite(e) ? e : 0;
  return Math.min(Math.max(Math.round(t), 0), 2147e6);
}
function js(e, t) {
  return e === "full" ? "full" : typeof e == "number" && Number.isFinite(e) ? Math.min(Math.max(e, 0), 1) : t;
}
function $s(e = ar, t) {
  let n = Ws(t?.attempts, e.attempts), o = Ge(
    at(t?.minDelayMs, e.minDelayMs, 0)
  ), r = Math.max(
    o,
    Ge(at(t?.maxDelayMs, e.maxDelayMs, 0))
  );
  return {
    attempts: n,
    minDelayMs: o,
    maxDelayMs: r,
    jitter: js(t?.jitter, e.jitter)
  };
}
function Ks(e, t, n, o) {
  if (t === "full")
    return n === "symmetric" ? Math.max(0, Math.round(e * (0.5 + o() * 0.5))) : Math.max(0, Math.ceil(e * (1 + o())));
  if (t <= 0)
    return n === "positive" ? Math.ceil(e) : e;
  let r = o(), i = n === "positive" ? r * t : (r * 2 - 1) * t, s = e * (1 + i);
  return Math.max(0, n === "positive" ? Math.ceil(s) : Math.round(s));
}
function Vs(e, t = "Non-Error thrown") {
  if (e instanceof Error)
    return e;
  if (typeof e == "string")
    return new Error(e);
  let n = new Error(t, { cause: e });
  return (typeof e == "object" && e !== null || typeof e == "function") && Object.assign(n, e), n;
}
function Ys(e = {}) {
  let t = e.sleep ?? qs, n = e.random ?? Math.random, o = e.createFailure ?? ((r) => Vs(r.at(-1) ?? new Error("Retry failed")));
  return async function(i, s = 3, a = 300) {
    let l = [], u = typeof s == "number", h = typeof s == "number" ? { attempts: s } : s, p = $s(ar, h), g = p.attempts, c = p.minDelayMs, d = p.maxDelayMs > 0 ? p.maxDelayMs : Number.POSITIVE_INFINITY, m = h.retryAfterMaxDelayMs === void 0 ? d : Math.max(
      c,
      Ge(at(h.retryAfterMaxDelayMs, d, 0))
    ), f = h.random ?? n, y = h.sleep ?? t, w = h.shouldRetry ?? (() => !0);
    for (let b = 1; b <= g; b += 1)
      try {
        return await i();
      } catch (S) {
        if (l.push(S), b >= g || !w(S, b))
          break;
        if (u) {
          await t(Ge(a * 2 ** (b - 1)));
          continue;
        }
        let k = {
          attempt: b,
          maxAttempts: g,
          err: S,
          label: h.label
        }, R = h.retryAfterMs?.(S), I = typeof R == "number" && Number.isFinite(R), E = typeof h.delayMs == "function" ? h.delayMs(k) : h.delayMs, T = E === void 0 ? void 0 : Ge(E), M = I ? Math.max(R, c) : T === void 0 ? c * 2 ** (b - 1) : Math.max(T, c), _ = I ? m : d, A = Math.min(M, _), q = I && (R ?? 0) <= _, K = p.jitter === "full" && !I || q;
        A = Ks(
          A,
          p.jitter,
          K ? "positive" : "symmetric",
          f
        ), A = Math.min(Math.max(A, c), _), await h.onRetry?.({ ...k, delayMs: A }), A > 0 && await y(A);
      }
    throw o(l);
  };
}
var ar, qs, ju, Yt = C(() => {
  ar = {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 3e4,
    jitter: 0
  }, qs = async (e) => {
    let t = e;
    do {
      let n = Math.min(t, 2147e6);
      await new Promise((o) => {
        setTimeout(o, n);
      }), t -= n;
    } while (t > 0);
  };
  ju = Ys();
});

// openclaw/packages/gateway-client/src/protocol-client.ts
var cr = C(() => {
  D();
  Yt();
});

// openclaw/packages/gateway-client/src/reconnect-policy.ts
var np, lr = C(() => {
  Vt();
  np = /* @__PURE__ */ new Set([
    P.AUTH_TOKEN_MISSING,
    P.AUTH_BOOTSTRAP_TOKEN_INVALID,
    P.AUTH_PASSWORD_MISSING,
    P.AUTH_PASSWORD_MISMATCH,
    P.AUTH_RATE_LIMITED,
    P.AUTH_DEVICE_TOKEN_MISMATCH,
    P.AUTH_SCOPE_MISMATCH,
    P.AUTH_IDENTITY_HEADER_REQUIRED,
    P.AUTH_VERIFIED_USER_REQUIRED,
    P.CONTROL_UI_BUILD_MISMATCH,
    P.PAIRING_REQUIRED,
    P.PAIRING_REJECTED,
    P.PAIRING_EXPIRED,
    P.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    P.DEVICE_IDENTITY_REQUIRED
  ]);
});

// openclaw/packages/normalization-core/src/stable-stringify.ts
var dr = C(() => {
});

// openclaw/packages/gateway-protocol/src/gateway-error-details.ts
var ur = C(() => {
});

// openclaw/packages/gateway-client/src/session-projection-message-identity.ts
function pr(e) {
  return typeof e == "number" && Number.isSafeInteger(e) && e > 0 ? e : null;
}
function fr(e, t) {
  let n = L(L(e)?.__openclaw);
  return pr(n?.seq) ?? pr(t?.messageSeq);
}
function He(e) {
  let t = H(e);
  return t?.endsWith(":user") ? t.slice(0, -5) || null : t;
}
function Zt(e, t) {
  let n = L(e), o = H(n?.role)?.toLowerCase();
  if (!n || !o)
    return null;
  let r = L(n.__openclaw), i = H(r?.importedFrom), s = H(r?.cliSessionId), a = H(r?.externalId), l = L(r?.transcriptPosition), u = H(l?.source), p = !(u !== null && u.length <= 128 && typeof l?.rawSeq == "number" && Number.isSafeInteger(l.rawSeq) && l.rawSeq >= 0) && !!(i || s || a), g = H(r?.idempotencyKey) ?? H(n.idempotencyKey) ?? H(t?.idempotencyKey) ?? H(t?.clientRunId), c = He(g), d = He(t?.runId), m = He(r?.runId), f = He(
    L(n.openclawStreamFallback)?.runId
  ), y = H(r?.mirrorOrigin) !== null, w = o === "assistant" && H(n.api)?.toLowerCase() === "cli", b = w && c?.startsWith("cli-assistant:") ? H(c.slice(14)) : c, S = o === "assistant" ? m ?? d ?? f ?? (w || !y ? b : null) : m ?? b ?? d;
  return {
    role: o,
    id: H(r?.id) ?? H(t?.messageId),
    sequence: fr(e, t),
    idempotencyKey: g,
    sendId: o === "user" ? c ?? S : null,
    runId: S,
    isImported: p,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource: p && i && s && a ? JSON.stringify([i, s, a]) : null
  };
}
var hr = C(() => {
  D();
  F();
});

// openclaw/packages/gateway-client/src/session-projection.ts
var gr = C(() => {
  D();
  F();
  hr();
});

// openclaw/packages/normalization-core/src/result.ts
var mr = C(() => {
});

// openclaw/packages/normalization-core/src/agent-id.ts
var ct = C(() => {
  mr();
});

// openclaw/packages/normalization-core/src/uuid.ts
var Jt = C(() => {
});

// openclaw/packages/gateway-client/src/session-subscriptions.ts
var yr = C(() => {
  ct();
  Jt();
});

// openclaw/packages/gateway-protocol/src/client-info.ts
var Js, Xs, Tp, Ep, wr = C(() => {
  F();
  Js = {
    WEBCHAT_UI: "webchat-ui",
    CONTROL_UI: "openclaw-control-ui",
    BROWSER_COPILOT: "openclaw-browser-copilot",
    TUI: "openclaw-tui",
    WEBCHAT: "webchat",
    CLI: "cli",
    GATEWAY_CLIENT: "gateway-client",
    MACOS_APP: "openclaw-macos",
    // Native Linux UI uses the same trusted-client admission class as the macOS app.
    LINUX_APP: "openclaw-linux",
    IOS_APP: "openclaw-ios",
    WATCHOS_APP: "openclaw-watchos",
    ANDROID_APP: "openclaw-android",
    NODE_HOST: "node-host",
    WORKER: "openclaw-worker",
    TEST: "test",
    FINGERPRINT: "fingerprint",
    PROBE: "openclaw-probe"
  }, Xs = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    WORKER: "worker",
    PROBE: "probe",
    TEST: "test"
  }, Tp = new Set(Object.values(Js)), Ep = new Set(Object.values(Xs));
});

// openclaw/packages/gateway-protocol/src/session-row-deltas.ts
var br = C(() => {
});

// openclaw/packages/gateway-protocol/src/startup-unavailable.ts
var Sr = C(() => {
});

// openclaw/packages/gateway-protocol/src/version.ts
var kr = C(() => {
});

// openclaw/packages/gateway-client/src/browser.ts
var Rr = C(() => {
  er();
  tr();
  nr();
  or();
  ir();
  rr();
  sr();
  cr();
  lr();
  gr();
  yr();
  wr();
  Vt();
  ur();
  br();
  Sr();
  kr();
});

// openclaw/packages/normalization-core/src/balanced-json.ts
var xr = C(() => {
});

// openclaw/packages/normalization-core/src/boolean-coercion.ts
var vr = C(() => {
});

// openclaw/packages/normalization-core/src/cjk-chars.ts
var Qt, Qp, ef, Cr = C(() => {
  Qt = [
    [
      [183, 183],
      [12288, 12703],
      [19968, 40869],
      [44032, 55215],
      [65281, 65376]
    ],
    [
      [4352, 4607],
      [11904, 12287],
      [12704, 19967],
      [40870, 40959],
      [40960, 42239],
      [42752, 42759],
      [43360, 43391],
      [55216, 55295],
      [63744, 64255]
    ],
    [
      [711, 711],
      [713, 715],
      [729, 729],
      [746, 747],
      [773, 773],
      [803, 803],
      [65040, 65103],
      [65377, 65500],
      [65504, 65510]
    ],
    [[119648, 119665]],
    [
      [94176, 94207],
      [110576, 110591],
      [110592, 110959],
      [127488, 127743],
      [131072, 195103],
      [196608, 210047]
    ]
  ], Qp = new RegExp(
    `[${Qt.flatMap(
      (e) => e.map(([t, n]) => `\\u{${t.toString(16)}}-\\u{${n.toString(16)}}`)
    ).join("")}]`,
    "u"
  ), ef = (() => {
    let e = Math.max(
      ...Qt.flatMap((n) => n.map(([, o]) => o))
    ), t = new Uint8Array(e + 1);
    for (let [n, o] of Qt.entries())
      for (let [r, i] of o)
        t.fill(n + 1, r, i + 1);
    return t;
  })();
});

// openclaw/packages/normalization-core/src/code-points.ts
var en = C(() => {
});

// openclaw/packages/normalization-core/src/error-coercion.ts
var Qs, Er, Ar, Tr, _r = C(() => {
  Qs = /* @__PURE__ */ Symbol.for(
    "openclaw.provider-auth-persistence-error"
  ), Tr = class extends (Ar = AggregateError, Er = Qs, Ar) {
    constructor(n, o, { cause: r }) {
      super([o, r], n, { cause: r });
      this[Er] = !0;
      this.persistenceError = o, this.cleanupError = r;
    }
  };
});

// openclaw/packages/normalization-core/src/expect.ts
var tn = C(() => {
});

// openclaw/packages/normalization-core/src/format.ts
var Ir = C(() => {
  tn();
});

// openclaw/packages/normalization-core/src/json-coercion.ts
function nn(e) {
  try {
    return JSON.parse(e);
  } catch {
    return;
  }
}
function be(e) {
  return /^[\t\n\r ]*\{/.test(e) ? G(nn(e)) : void 0;
}
var rn = C(() => {
  D();
});

// openclaw/packages/normalization-core/src/response-bytes.ts
var Pr = C(() => {
});

// openclaw/packages/normalization-core/src/text-decoding.ts
var Dr = C(() => {
});

// openclaw/packages/normalization-core/src/utf16-slice.ts
function Mr(e) {
  return e >= 55296 && e <= 56319;
}
function Or(e) {
  return e >= 56320 && e <= 57343;
}
function Nr(e, t, n) {
  let o = e.length, r = t < 0 ? Math.max(o + t, 0) : Math.min(t, o), i = n === void 0 ? o : n < 0 ? Math.max(o + n, 0) : Math.min(n, o);
  if (i <= r)
    return "";
  if (r > 0 && r < o) {
    let s = e.charCodeAt(r);
    Or(s) && Mr(e.charCodeAt(r - 1)) && (r += 1);
  }
  if (i > 0 && i < o) {
    let s = e.charCodeAt(i - 1);
    Mr(s) && Or(e.charCodeAt(i)) && (i -= 1);
  }
  return e.slice(r, i);
}
function ze(e, t) {
  let n = Math.max(0, Math.floor(t));
  return e.length <= n ? e : Nr(e, 0, n);
}
var Pe = C(() => {
});

// openclaw/packages/normalization-core/src/index.ts
var Y = C(() => {
  xr();
  vr();
  Cr();
  en();
  _r();
  tn();
  Ir();
  rn();
  oe();
  D();
  Pr();
  dr();
  F();
  st();
  Dr();
  Pe();
});

// openclaw/packages/net-policy/src/redact-sensitive-url.ts
var Ur = C(() => {
  F();
});

// openclaw/src/logging/redact-pattern-runtime.ts
function Fr(e) {
  let t = e.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!t)
    return [e, "gi"];
  let n = t[1] ?? "", o = t[2] ?? "";
  return [n, o.includes("g") ? o : `${o}g`];
}
var Lr = C(() => {
});

// openclaw/packages/acp-core/src/structured-auth-redaction.ts
var lt, ae, De, Me, ie, se, dt, Se, U, Mf, Of, Br = C(() => {
  lt = "[A-Za-z0-9!#$%&'*+.^_`|~-]+", ae = String.raw`(?:\[REDACTED\]|[^\s\\"',;&#?<>)}\]]+)`, De = String.raw`\\{1,64}t`, Me = String.raw`(?:[ \t]+|${De})`, ie = String.raw`(?:[ \t]*\r?\n${Me}|[ \t]*\\{1,64}r\\{1,64}n${Me}|[ \t]*\\{1,64}n${Me}|[ \t]*${De}[ \t]*|[ \t]*)`, se = String.raw`(?:[ \t]*\r?\n${Me}|[ \t]*\\{1,64}r\\{1,64}n${Me}|[ \t]*\\{1,64}n${Me}|[ \t]*${De}[ \t]*|[ \t]+)`, dt = String.raw`(?:[ \t\r\n]*|[ \t]*\\{1,64}r\\{1,64}n(?:[ \t]*|${De})|[ \t]*\\{1,64}n(?:[ \t]*|${De})|[ \t]*${De}[ \t]*)`, Se = String.raw`(^|[^A-Za-z0-9_-]|\\{1,64}[rn])`, U = String.raw`(?:\\{1,64}["']|["']|)`, Mf = String.raw`${Se}(?:x-goog-api-key|api-key|apikey|x-api-token|x-access-token)${U}[ \t]*[:=]${ie}${U}([^\s\\"',;]+)`, Of = new RegExp(
    String.raw`${Se}(?:Proxy-)?Authorization${U}[ \t]*[:=]${ie}${U}(${lt})${se}`,
    "giu"
  );
});

// openclaw/src/logging/redact-pem.ts
var Gr, Hr = C(() => {
  Gr = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`;
});

// openclaw/src/logging/redact-patterns.ts
function sn(e) {
  let t = e.charCodeAt(0);
  return t >= 65 && t <= 90 || t >= 97 && t <= 122 || t >= 48 && t <= 57 || e === "/" || e === "+" || e === "=";
}
function Yr(e) {
  for (let t = 39; t < e.length; ) {
    let n = t;
    for (; n > t - 40 && sn(e[n]); )
      n--;
    if (n === t - 40)
      return Vr.test(e);
    t = n + 40;
  }
  return !1;
}
function* Ra(e) {
  if (!Yr(e))
    return;
  let t = {
    '"': '"',
    "'": "'",
    "`": "`",
    "<": ">",
    "(": ")",
    "[": "]",
    "{": "}"
  }, n = -1, o = -1, r, i = 0, s = [];
  for (let a = 0; a <= e.length; a++) {
    let l = e[a] ?? "", u = a === e.length || ba.test(l), h = i;
    if (i = l === "\\" ? i + 1 : 0, l && sn(l) ? n === -1 && (n = a) : n !== -1 && (a - n === 40 ? s.push({ start: n, end: a, origin: n, url: r }) : a - n > 40 && l === "@" && e[a - 41] === "/" && s.push({ start: a - 40, end: a, origin: n, url: r }), n = -1), u) {
      r && (r.end = Math.min(r.end, a));
      for (let p of s) {
        let g = p.url, c = g && !g.hasAt && g.portValid && (g.portStart === -1 || (g.authorityEnd === -1 ? g.end : g.authorityEnd) > g.portStart + 1), d = e[p.start - 1] ?? "", m = e[p.end] ?? "", f = p.start !== p.origin, y = g && g.portStart !== -1 && p.origin === g.portStart + 1 && g.authorityEnd > p.origin && p.end > g.authorityEnd && m === "@";
        if (!f && (d === "_" || sn(d)) || m === "_" || e.slice(p.origin - 8, p.origin) === ";base64," || c && !y && p.start >= g.start && p.end <= g.end)
          continue;
        let w = e.slice(p.start, p.end);
        Vr.test(w) && (yield { match: w, groups: [w], input: e, offset: p.start });
      }
      s.length = 0, o = -1, r = void 0;
      continue;
    }
    if (r && a >= r.start && (l === r.closing && h === r.closingEscapeDepth ? (r.end = Math.min(r.end, a), r = void 0) : ("?#\"'<>`|()[]{}".includes(l) && (r.end = Math.min(r.end, a)), r.queryOrFragment ||= l === "?" || l === "#", r.authorityEnd === -1 && (r.hasAt ||= l === "@", "/?#".includes(l) ? r.authorityEnd = a : a < r.end && (l === ":" ? (r.portValid &&= r.portStart === -1, r.portStart = a) : r.portStart !== -1 && (l < "0" || l > "9") && (r.portValid = !1))))), Sa.test(l))
      o === -1 && (o = a);
    else {
      if ((!r || a >= r.end && !r.queryOrFragment) && l === ":" && e.startsWith("//", a + 1) && o !== -1 && ka.test(e[o])) {
        let p = e[o - 1], g = 0;
        for (let c = o - 2; c >= 0 && e[c] === "\\"; c--)
          g++;
        r = {
          start: a + 3,
          end: e.length,
          authorityEnd: -1,
          portStart: -1,
          portValid: !0,
          hasAt: !1,
          queryOrFragment: !1,
          closing: p ? t[p] : void 0,
          closingEscapeDepth: g
        };
      }
      o = -1;
    }
  }
}
function* Ea(e) {
  if (!/pass\s*:/.test(e))
    return;
  let t = [...e.matchAll(va)];
  if (t.length === 0)
    return;
  let n = 0, o = !1;
  for (let r = 0; r < e.length; r++) {
    let i = t[n];
    if (!i)
      return;
    if (r === i.index) {
      n++;
      let a = e[r - 1] ?? "", l = i[1] !== "pass" || a === "." || a === "-" || a === "_";
      if (!(!l && !o && a === " " && Ca.test(e[r - 2] ?? ""))) {
        o = !0;
        let h = r + i[0].length;
        if (!l) {
          qr.lastIndex = h;
          let g = qr.exec(e)?.[0];
          g && (h += g.length, yield { match: e.slice(r, h), groups: [g], input: e, offset: r });
        }
        let p = t[n];
        for (; p && p.index < h; )
          n++, p = t[n];
        r = h - 1;
        continue;
      }
    }
    let s = e[r];
    s === `
` || s === "\r" ? o = !1 : (s === "=" || s === ":" && !Ta.test(e[r + 1] ?? " ")) && (o = !0);
  }
}
var Wr, Oe, ea, pt, ta, na, jr, an, $r, ra, Kr, zr, Bf, oa, ia, sa, aa, ca, la, da, ua, pa, fa, ha, ga, ma, ya, wa, ke, ut, Vr, ba, Sa, ka, xa, va, qr, Ca, Ta, Aa, _a, Ia, Zr, Jr, ft, Pa, Da, Ma, Oa, Na, Ua, Fa, La, Ba, Ga, Ha, Xr, Qr = C(() => {
  Br();
  Hr();
  Wr = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`, Oe = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`, ea = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`, pt = String.raw`aws[-_]?secret[-_]?access[-_]?key|awsSecretAccessKey|SecretAccessKey`, ta = String.raw`access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|client[-_]?secret|app[-_]?secret|private[-_]?key|${pt}|credential|authorization|token|key|secret|password|pass|passwd|auth|jwt|session|code|signature|x[-_]?amz[-_]?(?:signature|security[-_]?token)`, na = String.raw`${ta}|app[-_]?secret|credential|${Oe}`, jr = String.raw`access_token|refresh_token|id_token|auth[-_]?token|hook[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|private[-_]?key|authorization|jwt|token|secret|password|pass|passwd|credential|${Oe}`, an = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|credential|${Oe}`, $r = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|passwd|credential|${Oe}`, ra = String.raw`access-token|refresh-token|id-token|auth-token|hook-token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|passphrase`, Kr = String.raw`password|passphrase|pass|passwd`, zr = String.raw`${pt}|api[-_]?key|hook[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|private[-_]?key|client[-_]?secret|${Oe}`, Bf = String.raw`\p{C}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0`, oa = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${Wr})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`, ia = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${Wr})\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g`, sa = String.raw`(^|[\s,;({\["])(?:${jr})=(["'\x60])((?:(?!\2)[^\r\n])+)\2`, aa = String.raw`(^|[\s,;({\["])(?:${jr})=(["'\x60]?[^\s&#"'\x60<>]+)`, ca = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|${Oe}`, la = String.raw`/(^|[\s,{])(?:(?:${ca})(?:\s*:\s*|\s+=\s*|=\s*)|[a-z0-9][a-z0-9._-]{0,79}[-_](?:${Kr})\s*[:=]\s*|[a-z0-9_.-]{1,80}\.(?:${an})\s*[:=]\s*)(["'\x60])((?:(?!\2)[^\r\n])+)\2/g`, da = String.raw`/(^|[\s,{])(?:(?:${$r})\s*:\s*|(?:${an})(?:\s+=\s*|=\s+))([^\s#"'\x60<>]+)/g`, ua = String.raw`/(^|[\s,{])(?:${ra})=([^\s#"'\x60<>]+)/g`, pa = String.raw`/(^|[\s,{])[a-z0-9][a-z0-9._-]{0,79}[-_](?:${Kr})\s*[:=]\s*([^\s#"'\x60<>]+)/g`, fa = String.raw`/(^|[\s,{])[a-z0-9_.-]{1,80}\.(?:${an})\s*[:=]\s*([^\s#"'\x60<>]+)/g`, ha = String.raw`"(?:apiKey|api_key|apiToken|api_token|bearerToken|bearer_token|token|secret|password|passwd|${pt}|credential|authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|authToken|auth_token|clientSecret|client_secret|privateKey|private_key|secret_value|raw_secret|secret_input|key_material)"\s*:\s*"([^"]+)"`, ga = String.raw`"(?:${ea})"\s*:\s*"([^"]+)"`, ma = String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|id[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret|private[-_]key|credential|authorization|secret[-_]value|raw[-_]secret|secret[-_]input|key[-_]material)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`, ya = String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`, wa = String.raw`(^|[^A-Za-z0-9])`, ke = (e) => String.raw`${wa}(?=${e})(?<!;base64,[A-Za-z0-9+/=]*)(${e})`, ut = String.raw`(^|[^A-Za-z0-9_])`;
  Vr = /(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[0-9/+=])(?=[A-Za-z0-9/+=]{0,39}[G-Zg-z/+=])[A-Za-z0-9/+=]{40}/u;
  ba = /\s/, Sa = /[A-Za-z0-9+.-]/, ka = /[A-Za-z]/;
  xa = Object.freeze({
    source: "aws-secret-access-key",
    exec: Ra,
    couldMatch: Yr
  }), va = new RegExp(
    String.raw`(?<![A-Za-z0-9])(pass|${$r})\s*:\s*`,
    "gi"
  ), qr = /[^\s#"'\x60<>]+/y, Ca = /[A-Za-z0-9]/, Ta = /[ \t\r\n]/;
  Aa = Object.freeze({
    source: "bare-pass-assignment",
    exec: Ea
  }), _a = String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`, Ia = String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`, Zr = "x-goog-api-key|api-key|apikey|x-api-token|x-access-token", Jr = "X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token", ft = String.raw`(^|[^A-Za-z0-9_?&-]|\\{1,64}[rn])`, Pa = String.raw`${ft}(?:${Zr})${U}[ \t]*:${ie}${U}([^\s\\"',;]+)`, Da = String.raw`${ft}(?:${Zr})${U}[ \t]*=${ie}${U}([^\s\\"',;]+)`, Ma = String.raw`${ft}(?:${Jr})\s*:\s*([^\s"',;]+)`, Oa = String.raw`${ft}(?:${Jr})\s*=\s*([^\s"',;]+)`, Na = [
    String.raw`${Se}Proxy-Authorization${U}[ \t]*[:=]${ie}${U}${lt}${se}(${ae})`,
    String.raw`${Se}Proxy-Authorization${U}[ \t]*[:=]${ie}${U}(${ae})[ \t]*(?=${U}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
    String.raw`${Se}Authorization${U}[ \t]*[:=]${ie}${U}(?!(?:Bearer|Basic|Bot)(?=${se}))${lt}${se}(${ae})`,
    String.raw`${Se}Authorization${U}[ \t]*[:=]${ie}${U}(?!(?:Bearer|Basic|Bot)(?=${se}))(${ae})[ \t]*(?=${U}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
    Pa,
    Da
  ], Ua = String.raw`Authorization${U}[ \t]*[:=]${dt}${U}Bearer${se}(${ae})`, Fa = String.raw`Authorization${U}[ \t]*[:=]${dt}${U}Basic${se}(${ae})`, La = String.raw`Authorization${U}[ \t]*[:=]${dt}${U}Bot${se}(${ae})`, Ba = String.raw`\bBearer\s+([-A-Za-z0-9._~+/=]{18,})(?![-A-Za-z0-9._~+/=])`, Ga = [
    oa,
    ia,
    ha,
    ga,
    ma,
    ya,
    String.raw`--(?:${zr})=([^\s"']+)`,
    String.raw`--(?:${zr})\s+(?!(?:or|and)\b(?=\s+--))(["']?)([^\s"']+)\1`,
    Ua,
    Fa,
    La,
    ...Na,
    Ma,
    Oa,
    Ba,
    String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`,
    String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`,
    String.raw`(^|[\s,;])(?:${na})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`,
    sa,
    aa,
    la,
    da,
    // Runs where the generic rule handled bare `pass:`, before the namespaced and prefixed rules.
    Aa,
    ua,
    pa,
    fa,
    Gr,
    String.raw`(^|[\s,{])["']?(?:${pt})["']?\s*[:=]\s*(["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])\2`
  ], Ha = [
    String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
    String.raw`(ghp_[A-Za-z0-9]{10,})`,
    String.raw`(github_pat_[A-Za-z0-9_]{10,})`,
    String.raw`(gho_[A-Za-z0-9]{10,})`,
    String.raw`(ghu_[A-Za-z0-9]{10,})`,
    String.raw`(ghs_[A-Za-z0-9]{10,})`,
    String.raw`(ghr_[A-Za-z0-9]{10,})`,
    String.raw`(glpat-[A-Za-z0-9._=\-]{20,})`,
    String.raw`(gloas-(?:[A-Fa-f0-9]{65,}|[A-Za-z0-9_-]{64}|[A-Fa-f0-9]{32,}))`,
    String.raw`(gldt-[A-Za-z0-9_-]{20,})`,
    String.raw`(glcbt-[A-Za-z0-9]{1,5}_[A-Za-z0-9_-]{20,})`,
    String.raw`(glptt-[A-Za-z0-9_-]{40,})`,
    String.raw`(glft-(?:[A-Za-z0-9_-]{20,}|[a-h0-9]+-[0-9]+_))`,
    String.raw`(glimt-[A-Za-z0-9_-]{25,})`,
    String.raw`(glagent-[A-Za-z0-9_-]{50,})`,
    String.raw`(glwt-[A-Za-z0-9_-]{20,})`,
    String.raw`(glsoat-[A-Za-z0-9_-]{20,})`,
    String.raw`(glffct-[A-Za-z0-9_-]{20,})`,
    String.raw`(glrt-[A-Za-z0-9._-]{20,})`,
    String.raw`(glrtr?-[A-Za-z0-9_-]{27,300}\.[0-9a-z]{2}\.[0-9a-z]{9})`,
    String.raw`(GR1348941[A-Za-z0-9_-]{20,})`,
    String.raw`(_gitlab_session=[A-Za-z0-9%._-]{20,})`,
    String.raw`(xox[baprs]-[A-Za-z0-9-]{10,})`,
    String.raw`(xapp-[A-Za-z0-9-]{10,})`,
    String.raw`(https:\/\/hooks\.slack\.com\/(?:services\/T[A-Z0-9]+\/B[A-Z0-9]+|workflows\/T[A-Z0-9]+\/A[A-Z0-9]+\/[0-9]{17,19})\/[A-Za-z0-9]{20,})`,
    String.raw`(https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,})`,
    String.raw`discord(?:.|\n|\r){0,40}?\b([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b`,
    String.raw`(gsk_[A-Za-z0-9_-]{10,})`,
    String.raw`(AIza[0-9A-Za-z\-_]{20,})`,
    String.raw`(ya29\.[0-9A-Za-z_\-./+=]{10,})`,
    String.raw`(1//0[0-9A-Za-z_\-./+=]{10,})`,
    String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
    String.raw`(pplx-[A-Za-z0-9_-]{10,})`,
    String.raw`(fal_[A-Za-z0-9_-]{10,})`,
    String.raw`${ut}(fc-[A-Za-z0-9]{10,})`,
    String.raw`(bb_live_[A-Za-z0-9_-]{10,})`,
    ke(String.raw`gAAAA[A-Za-z0-9_=-]{20,}`),
    String.raw`(sk_live_[A-Za-z0-9]{10,})`,
    String.raw`(sk_test_[A-Za-z0-9]{10,})`,
    String.raw`(rk_live_[A-Za-z0-9]{10,})`,
    String.raw`(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
    String.raw`(npm_[A-Za-z0-9]{10,})`,
    String.raw`(pypi-[A-Za-z0-9_-]{10,})`,
    String.raw`(dop_v1_[A-Za-z0-9]{10,})`,
    String.raw`(doo_v1_[A-Za-z0-9]{10,})`,
    String.raw`(dor_v1_[A-Za-z0-9]{10,})`,
    String.raw`(dp\.(?:ct|pt|sa|scim|audit)\.[A-Za-z0-9]{40,44})`,
    String.raw`(dp\.st\.[A-Za-z0-9]{40,44})`,
    String.raw`(dp\.st\.[a-z0-9_-]{2,35}\.[A-Za-z0-9]{40,44})`,
    String.raw`(dckr_(?:pat|oat)_[A-Za-z0-9_-]{27,32})`,
    String.raw`(bkua_[a-z0-9]{40})`,
    String.raw`(CCIPAT_[A-Za-z0-9]{22}_[A-Fa-f0-9]{40})`,
    String.raw`(sbp_[a-z0-9]{40})`,
    ke(String.raw`dapi[0-9a-f]{32}(?:-\d)?`),
    String.raw`(dd[pw]_[A-Za-z0-9]{36})`,
    String.raw`(glsa_[A-Za-z0-9_]{41})`,
    String.raw`(glc_eyJ[A-Za-z0-9+/=]{60,160})`,
    String.raw`(nfp_[A-Za-z0-9_]{36})`,
    String.raw`(CFPAT-[A-Za-z0-9_\-]{40,})`,
    ke(String.raw`ATCTT3xFfG[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8}`),
    ke(String.raw`ATATT[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8}`),
    ke(String.raw`ATBB[A-Za-z0-9_=.-]{16,}`),
    String.raw`(BBDC-[A-Za-z0-9+/@_-]{40,50})`,
    String.raw`(HRKU-AA[A-Za-z0-9_-]{20,})`,
    String.raw`(pat-(?:eu|na)1-[A-Za-z0-9]{8}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{12})`,
    String.raw`(apify_api_[A-Za-z0-9\-]{20,})`,
    String.raw`(FlyV1 fm\d+_[A-Za-z0-9+/=,_-]{100,})`,
    String.raw`(fio-u-[A-Za-z0-9_-]{40,})`,
    String.raw`(^|[^A-Za-z0-9_])(am_[A-Za-z0-9_-]{10,})`,
    String.raw`(^|[^A-Za-z0-9_])(sk_[A-Za-z0-9_]{10,})`,
    String.raw`(tvly-[A-Za-z0-9]{10,})`,
    String.raw`(exa_[A-Za-z0-9]{10,})`,
    String.raw`(syt_[A-Za-z0-9]{10,})`,
    String.raw`(retaindb_[A-Za-z0-9]{10,})`,
    String.raw`(hsk-[A-Za-z0-9]{10,})`,
    String.raw`(mem0_[A-Za-z0-9]{10,})`,
    String.raw`(brv_[A-Za-z0-9]{10,})`,
    String.raw`(xai-[A-Za-z0-9]{30,})`,
    String.raw`${ut}(fw-[A-Za-z0-9]{30,})`,
    String.raw`${ut}(fw_[A-Za-z0-9]{30,})`,
    String.raw`${ut}(fpk_[A-Za-z0-9]{30,})`,
    ke(String.raw`AKIA[A-Z0-9]{16}`),
    ke(String.raw`ASIA[A-Z0-9]{16}`),
    String.raw`(AKID[A-Za-z0-9]{10,})`,
    String.raw`(LTAI[A-Za-z0-9]{10,})`,
    String.raw`(hf_[A-Za-z0-9]{10,})`,
    String.raw`(api_org_[A-Za-z0-9]{20,})`,
    String.raw`(r8_[A-Za-z0-9]{10,})`,
    _a,
    Ia
  ], Xr = [
    ...Ga,
    ...Ha,
    xa
  ];
});

// openclaw/ui/src/lib/browser-redact.ts
var Vf, eo = C(() => {
  Ur();
  Pe();
  Lr();
  Qr();
  Vf = Xr.map(
    (e) => typeof e == "string" ? new RegExp(...Fr(e)) : e
  );
});

// openclaw/ui/src/lib/format-error.ts
var ht = C(() => {
  Y();
  eo();
});

// openclaw/src/shared/control-ui-storage.ts
var no, qa, ro = C(() => {
  no = "openclaw.device.auth.v1", qa = `${no}:`;
});

// openclaw/src/shared/device-auth.ts
var cn = C(() => {
  st();
});

// openclaw/ui/src/local-storage.ts
var oo = C(() => {
});

// openclaw/ui/src/lib/bytes-base64.ts
var io = C(() => {
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
function Wa(e, t = !1) {
  return t ? { h: Number(e & gt), l: Number(e >> so & gt) } : { h: Number(e >> so & gt) | 0, l: Number(e & gt) | 0 };
}
function ao(e, t = !1) {
  let n = e.length, o = new Uint32Array(n), r = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let { h: s, l: a } = Wa(e[i], t);
    [o[i], r[i]] = [s, a];
  }
  return [o, r];
}
function co(e, t, n, o) {
  let r = ja(n), i = $a(n);
  e.setUint32(t, o ? i : r, o), e.setUint32(t + 4, o ? r : i, o);
}
function Q(e, t, n, o) {
  let r = (t >>> 0) + (o >>> 0);
  return { h: e + n + (r / 2 ** 32 | 0) | 0, l: r | 0 };
}
var gt, so, ja, $a, ln, dn, Re, xe, qe, We, lo, uo, po, fo, ho, go, un = C(() => {
  gt = BigInt(4294967295), so = /* @__PURE__ */ BigInt(32);
  ja = (e) => e / 2 ** 32 | 0, $a = (e) => e >>> 0;
  ln = (e, t, n) => e >>> n, dn = (e, t, n) => e << 32 - n | t >>> n, Re = (e, t, n) => e >>> n | t << 32 - n, xe = (e, t, n) => e << 32 - n | t >>> n, qe = (e, t, n) => e << 64 - n | t >>> n - 32, We = (e, t, n) => e >>> n - 32 | t << 64 - n;
  lo = (e, t, n) => (e >>> 0) + (t >>> 0) + (n >>> 0), uo = (e, t, n, o) => t + n + o + (e / 2 ** 32 | 0) | 0, po = (e, t, n, o) => (e >>> 0) + (t >>> 0) + (n >>> 0) + (o >>> 0), fo = (e, t, n, o, r) => t + n + o + r + (e / 2 ** 32 | 0) | 0, ho = (e, t, n, o, r) => (e >>> 0) + (t >>> 0) + (n >>> 0) + (o >>> 0) + (r >>> 0), go = (e, t, n, o, r, i) => t + n + o + r + i + (e / 2 ** 32 | 0) | 0;
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
function mo(e) {
  return e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in e && e.BYTES_PER_ELEMENT === 1;
}
function Va(e, t = "") {
  if (typeof e != "number")
    throw new TypeError(pn(t) + "expected number, got " + typeof e);
  if (!Number.isSafeInteger(e) || e < 0)
    throw new RangeError(pn(t) + "expected integer >= 0, got " + e);
  return e;
}
function fn(e, t, n = "") {
  if (mo(e) && (t === void 0 || e.length === t))
    return e;
  t !== void 0 && Va(t, "length");
  let o = mo(e), r = t !== void 0 ? ` of length ${t}` : "", i = o ? `length=${e.length}` : `type=${typeof e}`, s = pn(n) + "expected Uint8Array" + r + ", got " + i;
  throw o ? new RangeError(s) : new TypeError(s);
}
function hn(e, t = !0) {
  if (e.destroyed)
    throw new Error("hash was destroyed");
  if (t && e.finished)
    throw new Error("digest() was already called");
}
function wo(e, t) {
  fn(e, void 0, "output");
  let n = t.outputLen;
  if (!(e.length >= n))
    throw new RangeError('"output" expected length >= ' + n);
}
function je(...e) {
  for (let t = 0; t < e.length; t++)
    e[t].fill(0);
}
function mt(e) {
  return new DataView(e.buffer, e.byteOffset, e.byteLength);
}
function Z(e, t) {
  return e << 32 - t | e >>> t;
}
function Za(e, t, n = "opts") {
  return yo(e, "defaults"), t !== void 0 && yo(t, n), Object.assign(/* @__PURE__ */ Object.create(null), e, t);
}
function ve(e, t = {}) {
  if (typeof e != "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof e);
  t = Za({}, t, "info");
  let n = (r, i) => e(i).update(r).digest(), o = e(void 0);
  return n.outputLen = o.outputLen, n.blockLen = o.blockLen, n.canXOF = o.canXOF, n.create = (r) => e(r), Object.assign(n, t), Object.freeze(n);
}
var pn, Ya, yo, Ce, gn = C(() => {
  pn = (e) => e ? `"${e}" ` : "";
  Ya = (e, t) => {
    if (e === null || typeof e != "object" || Array.isArray(e))
      throw new TypeError((t === "object" ? "" : `"${t}" `) + "expected object, got type=" + typeof e);
  }, yo = (e, t) => {
    Ya(e, t);
    let n = Object.getPrototypeOf(e);
    if (n !== Object.prototype && n !== null)
      throw new TypeError(`"${t}" expected plain object`);
    if (Object.hasOwn(e, "__proto__"))
      throw new TypeError(`"${t}.__proto__" is not allowed`);
  };
  Ce = (e) => ({
    // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
    // Larger suffix values would need base-128 OID encoding and a different length byte.
    oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, e])
  });
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_md.js
function bo(e, t, n) {
  return e & t ^ ~e & n;
}
function So(e, t, n) {
  return e & t ^ e & n ^ t & n;
}
var $e, ko, Ro, xo, vo, Co = C(() => {
  un();
  gn();
  $e = class {
    blockLen;
    outputLen;
    canXOF = !1;
    padOffset;
    isLE;
    // For partial updates less than block size
    buffer;
    view;
    finished = !1;
    length = 0;
    pos = 0;
    destroyed = !1;
    constructor(t, n, o, r) {
      this.blockLen = t, this.outputLen = n, this.padOffset = o, this.isLE = r, this.buffer = new Uint8Array(t), this.view = mt(this.buffer);
    }
    update(t) {
      hn(this), fn(t);
      let { view: n, buffer: o, blockLen: r } = this, i = t.length, s = !1;
      for (let a = 0; a < i; ) {
        let l = Math.min(r - this.pos, i - a);
        if (l === r) {
          let u = mt(t);
          for (; r <= i - a; a += r)
            this.process(u, a);
          s = !0;
          continue;
        }
        o.set(a === 0 && l === i ? t : t.subarray(a, a + l), this.pos), this.pos += l, a += l, this.pos === r && (this.process(n, 0), this.pos = 0, s = !0);
      }
      return this.length += t.length, s && this.roundClean(), this;
    }
    digestInto(t) {
      hn(this), wo(t, this), this.finished = !0;
      let { buffer: n, view: o, blockLen: r, isLE: i } = this, { pos: s } = this;
      n[s++] = 128, n.fill(0, s), this.padOffset > r - s && (this.process(o, 0), n.fill(0)), co(o, r - 8, this.length * 8, i), this.process(o, 0), this.roundClean();
      let a = t === n ? o : mt(t), l = this.outputLen, u = l / 4, h = this.get();
      if (l % 4 || u > h.length)
        throw new Error("invalid outputLen");
      for (let p = 0; p < u; p++)
        a.setUint32(4 * p, h[p], i);
    }
    digest() {
      let { buffer: t, outputLen: n } = this;
      this.digestInto(t);
      let o = t.slice(0, n);
      return this.destroy(), o;
    }
    _cloneIntoMeta(t) {
      let { buffer: n, length: o, finished: r, destroyed: i, pos: s } = this;
      return t.destroyed = i, t.finished = r, t.length = o, t.pos = s, s && t.buffer.set(n), t;
    }
    clone() {
      return this._cloneInto();
    }
  }, ko = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]), Ro = /* @__PURE__ */ Uint32Array.from([
    3238371032,
    914150663,
    812702999,
    4144912697,
    4290775857,
    1750603025,
    1694076839,
    3204075428
  ]), xo = /* @__PURE__ */ Uint32Array.from([
    3418070365,
    3238371032,
    1654270250,
    914150663,
    2438529370,
    812702999,
    355462360,
    4144912697,
    1731405415,
    4290775857,
    2394180231,
    1750603025,
    3675008525,
    1694076839,
    1203062813,
    3204075428
  ]), vo = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js
var Eo = {};
Ht(Eo, {
  _SHA224: () => bt,
  _SHA256: () => wt,
  _SHA384: () => kt,
  _SHA512: () => St,
  _SHA512_224: () => Rt,
  _SHA512_256: () => xt,
  sha224: () => rc,
  sha256: () => nc,
  sha384: () => ic,
  sha512: () => oc,
  sha512_224: () => ac,
  sha512_256: () => sc
});
var Ja, ce, yt, wt, bt, To, Xa, Qa, le, de, Ne, St, kt, ec, tc, Rt, xt, nc, rc, oc, ic, sc, ac, Ao = C(() => {
  Co();
  un();
  gn();
  Ja = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]), ce = /* @__PURE__ */ new Uint32Array(64), yt = class extends $e {
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    // Numeric initializers matter: starting the fields as `undefined` changes
    // V8's field representation and makes sha256 3x slower (measured).
    A = 0;
    B = 0;
    C = 0;
    D = 0;
    E = 0;
    F = 0;
    G = 0;
    H = 0;
    constructor(t, n) {
      super(64, t, 8, !1), this.A = n[0] | 0, this.B = n[1] | 0, this.C = n[2] | 0, this.D = n[3] | 0, this.E = n[4] | 0, this.F = n[5] | 0, this.G = n[6] | 0, this.H = n[7] | 0;
    }
    get() {
      let { A: t, B: n, C: o, D: r, E: i, F: s, G: a, H: l } = this;
      return [t, n, o, r, i, s, a, l];
    }
    // prettier-ignore
    set(t, n, o, r, i, s, a, l) {
      this.A = t | 0, this.B = n | 0, this.C = o | 0, this.D = r | 0, this.E = i | 0, this.F = s | 0, this.G = a | 0, this.H = l | 0;
    }
    _cloneInto(t) {
      return (t ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(t);
    }
    process(t, n) {
      for (let p = 0; p < 16; p++, n += 4)
        ce[p] = t.getUint32(n, !1);
      for (let p = 16; p < 64; p++) {
        let g = ce[p - 15], c = ce[p - 2], d = Z(g, 7) ^ Z(g, 18) ^ g >>> 3, m = Z(c, 17) ^ Z(c, 19) ^ c >>> 10;
        ce[p] = m + ce[p - 7] + d + ce[p - 16] | 0;
      }
      let { A: o, B: r, C: i, D: s, E: a, F: l, G: u, H: h } = this;
      for (let p = 0; p < 64; p++) {
        let g = Z(a, 6) ^ Z(a, 11) ^ Z(a, 25), c = h + g + bo(a, l, u) + Ja[p] + ce[p] | 0, m = (Z(o, 2) ^ Z(o, 13) ^ Z(o, 22)) + So(o, r, i) | 0;
        h = u, u = l, l = a, a = s + c | 0, s = i, i = r, r = o, o = c + m | 0;
      }
      o = o + this.A | 0, r = r + this.B | 0, i = i + this.C | 0, s = s + this.D | 0, a = a + this.E | 0, l = l + this.F | 0, u = u + this.G | 0, h = h + this.H | 0, this.set(o, r, i, s, a, l, u, h);
    }
    roundClean() {
      je(ce);
    }
    destroy() {
      this.destroyed = !0, this.set(0, 0, 0, 0, 0, 0, 0, 0), je(this.buffer);
    }
  }, wt = class extends yt {
    constructor() {
      super(32, ko);
    }
  }, bt = class extends yt {
    constructor() {
      super(28, Ro);
    }
  }, To = ao([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((e) => BigInt(e))), Xa = To[0], Qa = To[1], le = /* @__PURE__ */ new Uint32Array(80), de = /* @__PURE__ */ new Uint32Array(80), Ne = class extends $e {
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    // h -- high 32 bits, l -- low 32 bits
    // Numeric initializers matter: starting the fields as `undefined` changes
    // V8's field representation and slows hashing down (measured on sha256).
    Ah = 0;
    Al = 0;
    Bh = 0;
    Bl = 0;
    Ch = 0;
    Cl = 0;
    Dh = 0;
    Dl = 0;
    Eh = 0;
    El = 0;
    Fh = 0;
    Fl = 0;
    Gh = 0;
    Gl = 0;
    Hh = 0;
    Hl = 0;
    constructor(t, n) {
      super(128, t, 16, !1), this.Ah = n[0] | 0, this.Al = n[1] | 0, this.Bh = n[2] | 0, this.Bl = n[3] | 0, this.Ch = n[4] | 0, this.Cl = n[5] | 0, this.Dh = n[6] | 0, this.Dl = n[7] | 0, this.Eh = n[8] | 0, this.El = n[9] | 0, this.Fh = n[10] | 0, this.Fl = n[11] | 0, this.Gh = n[12] | 0, this.Gl = n[13] | 0, this.Hh = n[14] | 0, this.Hl = n[15] | 0;
    }
    // prettier-ignore
    get() {
      let { Ah: t, Al: n, Bh: o, Bl: r, Ch: i, Cl: s, Dh: a, Dl: l, Eh: u, El: h, Fh: p, Fl: g, Gh: c, Gl: d, Hh: m, Hl: f } = this;
      return [t, n, o, r, i, s, a, l, u, h, p, g, c, d, m, f];
    }
    // prettier-ignore
    set(t, n, o, r, i, s, a, l, u, h, p, g, c, d, m, f) {
      this.Ah = t | 0, this.Al = n | 0, this.Bh = o | 0, this.Bl = r | 0, this.Ch = i | 0, this.Cl = s | 0, this.Dh = a | 0, this.Dl = l | 0, this.Eh = u | 0, this.El = h | 0, this.Fh = p | 0, this.Fl = g | 0, this.Gh = c | 0, this.Gl = d | 0, this.Hh = m | 0, this.Hl = f | 0;
    }
    _cloneInto(t) {
      return (t ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(t);
    }
    process(t, n) {
      for (let b = 0; b < 16; b++, n += 4)
        le[b] = t.getUint32(n), de[b] = t.getUint32(n += 4);
      for (let b = 16; b < 80; b++) {
        let S = le[b - 15] | 0, k = de[b - 15] | 0, R = Re(S, k, 1) ^ Re(S, k, 8) ^ ln(S, k, 7), I = xe(S, k, 1) ^ xe(S, k, 8) ^ dn(S, k, 7), E = le[b - 2] | 0, T = de[b - 2] | 0, M = Re(E, T, 19) ^ qe(E, T, 61) ^ ln(E, T, 6), _ = xe(E, T, 19) ^ We(E, T, 61) ^ dn(E, T, 6), A = po(I, _, de[b - 7], de[b - 16]), q = fo(A, R, M, le[b - 7], le[b - 16]);
        le[b] = q | 0, de[b] = A | 0;
      }
      let { Ah: o, Al: r, Bh: i, Bl: s, Ch: a, Cl: l, Dh: u, Dl: h, Eh: p, El: g, Fh: c, Fl: d, Gh: m, Gl: f, Hh: y, Hl: w } = this;
      for (let b = 0; b < 80; b++) {
        let S = Re(p, g, 14) ^ Re(p, g, 18) ^ qe(p, g, 41), k = xe(p, g, 14) ^ xe(p, g, 18) ^ We(p, g, 41), R = p & c ^ ~p & m, I = g & d ^ ~g & f, E = ho(w, k, I, Qa[b], de[b]), T = go(E, y, S, R, Xa[b], le[b]), M = E | 0, _ = Re(o, r, 28) ^ qe(o, r, 34) ^ qe(o, r, 39), A = xe(o, r, 28) ^ We(o, r, 34) ^ We(o, r, 39), q = o & i ^ o & a ^ i & a, K = r & s ^ r & l ^ s & l;
        y = m | 0, w = f | 0, m = c | 0, f = d | 0, c = p | 0, d = g | 0, { h: p, l: g } = Q(u | 0, h | 0, T | 0, M | 0), u = a | 0, h = l | 0, a = i | 0, l = s | 0, i = o | 0, s = r | 0;
        let j = lo(M, A, K);
        o = uo(j, T, _, q), r = j | 0;
      }
      ({ h: o, l: r } = Q(this.Ah | 0, this.Al | 0, o | 0, r | 0)), { h: i, l: s } = Q(this.Bh | 0, this.Bl | 0, i | 0, s | 0), { h: a, l } = Q(this.Ch | 0, this.Cl | 0, a | 0, l | 0), { h: u, l: h } = Q(this.Dh | 0, this.Dl | 0, u | 0, h | 0), { h: p, l: g } = Q(this.Eh | 0, this.El | 0, p | 0, g | 0), { h: c, l: d } = Q(this.Fh | 0, this.Fl | 0, c | 0, d | 0), { h: m, l: f } = Q(this.Gh | 0, this.Gl | 0, m | 0, f | 0), { h: y, l: w } = Q(this.Hh | 0, this.Hl | 0, y | 0, w | 0), this.set(o, r, i, s, a, l, u, h, p, g, c, d, m, f, y, w);
    }
    roundClean() {
      je(le, de);
    }
    destroy() {
      this.destroyed = !0, je(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }, St = class extends Ne {
    constructor() {
      super(64, vo);
    }
  }, kt = class extends Ne {
    constructor() {
      super(48, xo);
    }
  }, ec = /* @__PURE__ */ Uint32Array.from([
    2352822216,
    424955298,
    1944164710,
    2312950998,
    502970286,
    855612546,
    1738396948,
    1479516111,
    258812777,
    2077511080,
    2011393907,
    79989058,
    1067287976,
    1780299464,
    286451373,
    2446758561
  ]), tc = /* @__PURE__ */ Uint32Array.from([
    573645204,
    4230739756,
    2673172387,
    3360449730,
    596883563,
    1867755857,
    2520282905,
    1497426621,
    2519219938,
    2827943907,
    3193839141,
    1401305490,
    721525244,
    746961066,
    246885852,
    2177182882
  ]), Rt = class extends Ne {
    constructor() {
      super(28, ec);
    }
  }, xt = class extends Ne {
    constructor() {
      super(32, tc);
    }
  }, nc = /* @__PURE__ */ ve(
    () => new wt(),
    /* @__PURE__ */ Ce(1)
  ), rc = /* @__PURE__ */ ve(
    () => new bt(),
    /* @__PURE__ */ Ce(4)
  ), oc = /* @__PURE__ */ ve(
    () => new St(),
    /* @__PURE__ */ Ce(3)
  ), ic = /* @__PURE__ */ ve(
    () => new kt(),
    /* @__PURE__ */ Ce(2)
  ), sc = /* @__PURE__ */ ve(
    () => new xt(),
    /* @__PURE__ */ Ce(6)
  ), ac = /* @__PURE__ */ ve(
    () => new Rt(),
    /* @__PURE__ */ Ce(5)
  );
});

// openclaw/ui/src/lib/nodes/index.ts
var dc, _o, mn = C(() => {
  Qn();
  D();
  ro();
  cn();
  oo();
  io();
  dc = () => Promise.resolve().then(() => (Ao(), Eo)), _o = Kt.sha512Async;
  Kt.sha512Async = async (e) => globalThis.crypto?.subtle && _o ? await _o(e) : Uint8Array.from((await dc()).sha512(e));
});

// openclaw/node_modules/.pnpm/punycode.js@2.3.1/node_modules/punycode.js/punycode.js
var Pi = Hn((fb, Ii) => {
  "use strict";
  var ul = /^xn--/, pl = /[^\0-\x7F]/, fl = /[\x2E\u3002\uFF0E\uFF61]/g, hl = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  }, In = 35, ee = Math.floor, Pn = String.fromCharCode;
  function pe(e) {
    throw new RangeError(hl[e]);
  }
  function gl(e, t) {
    let n = [], o = e.length;
    for (; o--; )
      n[o] = t(e[o]);
    return n;
  }
  function Ci(e, t) {
    let n = e.split("@"), o = "";
    n.length > 1 && (o = n[0] + "@", e = n[1]), e = e.replace(fl, ".");
    let r = e.split("."), i = gl(r, t).join(".");
    return o + i;
  }
  function Ti(e) {
    let t = [], n = 0, o = e.length;
    for (; n < o; ) {
      let r = e.charCodeAt(n++);
      if (r >= 55296 && r <= 56319 && n < o) {
        let i = e.charCodeAt(n++);
        (i & 64512) == 56320 ? t.push(((r & 1023) << 10) + (i & 1023) + 65536) : (t.push(r), n--);
      } else
        t.push(r);
    }
    return t;
  }
  var ml = (e) => String.fromCodePoint(...e), yl = function(e) {
    return e >= 48 && e < 58 ? 26 + (e - 48) : e >= 65 && e < 91 ? e - 65 : e >= 97 && e < 123 ? e - 97 : 36;
  }, vi = function(e, t) {
    return e + 22 + 75 * (e < 26) - ((t != 0) << 5);
  }, Ei = function(e, t, n) {
    let o = 0;
    for (e = n ? ee(e / 700) : e >> 1, e += ee(e / t); e > In * 26 >> 1; o += 36)
      e = ee(e / In);
    return ee(o + (In + 1) * e / (e + 38));
  }, Ai = function(e) {
    let t = [], n = e.length, o = 0, r = 128, i = 72, s = e.lastIndexOf("-");
    s < 0 && (s = 0);
    for (let a = 0; a < s; ++a)
      e.charCodeAt(a) >= 128 && pe("not-basic"), t.push(e.charCodeAt(a));
    for (let a = s > 0 ? s + 1 : 0; a < n; ) {
      let l = o;
      for (let h = 1, p = 36; ; p += 36) {
        a >= n && pe("invalid-input");
        let g = yl(e.charCodeAt(a++));
        g >= 36 && pe("invalid-input"), g > ee((2147483647 - o) / h) && pe("overflow"), o += g * h;
        let c = p <= i ? 1 : p >= i + 26 ? 26 : p - i;
        if (g < c)
          break;
        let d = 36 - c;
        h > ee(2147483647 / d) && pe("overflow"), h *= d;
      }
      let u = t.length + 1;
      i = Ei(o - l, u, l == 0), ee(o / u) > 2147483647 - r && pe("overflow"), r += ee(o / u), o %= u, t.splice(o++, 0, r);
    }
    return String.fromCodePoint(...t);
  }, _i = function(e) {
    let t = [];
    e = Ti(e);
    let n = e.length, o = 128, r = 0, i = 72;
    for (let l of e)
      l < 128 && t.push(Pn(l));
    let s = t.length, a = s;
    for (s && t.push("-"); a < n; ) {
      let l = 2147483647;
      for (let h of e)
        h >= o && h < l && (l = h);
      let u = a + 1;
      l - o > ee((2147483647 - r) / u) && pe("overflow"), r += (l - o) * u, o = l;
      for (let h of e)
        if (h < o && ++r > 2147483647 && pe("overflow"), h === o) {
          let p = r;
          for (let g = 36; ; g += 36) {
            let c = g <= i ? 1 : g >= i + 26 ? 26 : g - i;
            if (p < c)
              break;
            let d = p - c, m = 36 - c;
            t.push(
              Pn(vi(c + d % m, 0))
            ), p = ee(d / m);
          }
          t.push(Pn(vi(p, 0))), i = Ei(r, u, a === s), r = 0, ++a;
        }
      ++r, ++o;
    }
    return t.join("");
  }, wl = function(e) {
    return Ci(e, function(t) {
      return ul.test(t) ? Ai(t.slice(4).toLowerCase()) : t;
    });
  }, bl = function(e) {
    return Ci(e, function(t) {
      return pl.test(t) ? "xn--" + _i(t) : t;
    });
  }, Sl = {
    /**
     * A string representing the current Punycode.js version number.
     * @memberOf punycode
     * @type String
     */
    version: "2.3.1",
    /**
     * An object of methods to convert from JavaScript's internal character
     * representation (UCS-2) to Unicode code points, and back.
     * @see <https://mathiasbynens.be/notes/javascript-encoding>
     * @memberOf punycode
     * @type Object
     */
    ucs2: {
      decode: Ti,
      encode: ml
    },
    decode: Ai,
    encode: _i,
    toASCII: bl,
    toUnicode: wl
  };
  Ii.exports = Sl;
});

// openclaw/node_modules/.pnpm/ipaddr.js@2.5.0/node_modules/ipaddr.js/lib/ipaddr.js
var as = Hn((ss, Bt) => {
  (function(e) {
    "use strict";
    let t = "(0?\\d+|0x[a-f0-9]+)", n = {
      fourOctet: new RegExp(`^${t}\\.${t}\\.${t}\\.${t}$`, "i"),
      threeOctet: new RegExp(`^${t}\\.${t}\\.${t}$`, "i"),
      twoOctet: new RegExp(`^${t}\\.${t}$`, "i"),
      longValue: new RegExp(`^${t}$`, "i")
    }, o = new RegExp("^0[0-7]+$", "i"), r = new RegExp("^0x[a-f0-9]+$", "i"), i = "%[0-9a-z]{1,}", s = "(?:[0-9a-f]+::?)+", a = {
      zoneIndex: new RegExp(i, "i"),
      native: new RegExp(`^(::)?(${s})?([0-9a-f]+)?(::)?(${i})?$`, "i"),
      deprecatedTransitional: new RegExp(`^(?:::)(${t}\\.${t}\\.${t}\\.${t}(${i})?)$`, "i"),
      transitional: new RegExp(`^((?:${s})|(?:::)(?:${s})?)${t}\\.${t}\\.${t}\\.${t}(${i})?$`, "i")
    };
    function l(c, d) {
      if (c.indexOf("::") !== c.lastIndexOf("::"))
        return null;
      let m = 0, f = -1, y = (c.match(a.zoneIndex) || [])[0], w, b;
      for (y && (y = y.substring(1), c = c.replace(/%.+$/, "")); (f = c.indexOf(":", f + 1)) >= 0; )
        m++;
      if (c.substr(0, 2) === "::" && m--, c.substr(-2, 2) === "::" && m--, m >= d)
        return null;
      for (b = d - m, w = ":"; b--; )
        w += "0:";
      return c = c.replace("::", w), c[0] === ":" && (c = c.slice(1)), c[c.length - 1] === ":" && (c = c.slice(0, -1)), d = (function() {
        let S = c.split(":"), k = [];
        for (let R = 0; R < S.length; R++)
          k.push(S[R].length > 4 ? NaN : parseInt(S[R], 16));
        return k;
      })(), {
        parts: d,
        zoneId: y
      };
    }
    function u(c, d, m, f) {
      if (c.length !== d.length)
        throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
      let y = 0, w;
      for (; f > 0; ) {
        if (w = m - f, w < 0 && (w = 0), c[y] >> w !== d[y] >> w)
          return !1;
        f -= m, y += 1;
      }
      return !0;
    }
    function h(c) {
      if (r.test(c))
        return parseInt(c, 16);
      if (c[0] === "0" && !isNaN(parseInt(c[1], 10))) {
        if (o.test(c))
          return parseInt(c, 8);
        throw new Error(`ipaddr: cannot parse ${c} as octal`);
      }
      return parseInt(c, 10);
    }
    function p(c, d) {
      for (; c.length < d; )
        c = `0${c}`;
      return c;
    }
    let g = {};
    g.IPv4 = (function() {
      function c(d) {
        if (d.length !== 4)
          throw new Error("ipaddr: ipv4 octet count should be 4");
        let m, f;
        for (m = 0; m < d.length; m++)
          if (f = d[m], !(0 <= f && f <= 255))
            throw new Error("ipaddr: ipv4 octet should fit in 8 bits");
        this.octets = d;
      }
      return c.prototype.SpecialRanges = {
        unspecified: [[new c([0, 0, 0, 0]), 8]],
        broadcast: [[new c([255, 255, 255, 255]), 32]],
        // RFC3171
        multicast: [[new c([224, 0, 0, 0]), 4]],
        // RFC3927
        linkLocal: [[new c([169, 254, 0, 0]), 16]],
        // RFC5735
        loopback: [[new c([127, 0, 0, 0]), 8]],
        // RFC6598
        carrierGradeNat: [[new c([100, 64, 0, 0]), 10]],
        // RFC1918
        private: [
          [new c([10, 0, 0, 0]), 8],
          [new c([172, 16, 0, 0]), 12],
          [new c([192, 168, 0, 0]), 16]
        ],
        // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
        reserved: [
          [new c([192, 0, 0, 0]), 24],
          [new c([192, 0, 2, 0]), 24],
          [new c([192, 88, 99, 0]), 24],
          [new c([198, 18, 0, 0]), 15],
          [new c([198, 51, 100, 0]), 24],
          [new c([203, 0, 113, 0]), 24],
          [new c([240, 0, 0, 0]), 4]
        ],
        // RFC7534, RFC7535
        as112: [
          [new c([192, 175, 48, 0]), 24],
          [new c([192, 31, 196, 0]), 24]
        ],
        // RFC7450
        amt: [
          [new c([192, 52, 193, 0]), 24]
        ]
      }, c.prototype.kind = function() {
        return "ipv4";
      }, c.prototype.match = function(d, m) {
        let f;
        if (m === void 0 && (f = d, d = f[0], m = f[1]), d.kind() !== "ipv4")
          throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
        return u(this.octets, d.octets, 8, m);
      }, c.prototype.prefixLengthFromSubnetMask = function() {
        let d = 0, m = !1, f = {
          0: 8,
          128: 7,
          192: 6,
          224: 5,
          240: 4,
          248: 3,
          252: 2,
          254: 1,
          255: 0
        }, y, w, b;
        for (y = 3; y >= 0; y -= 1)
          if (w = this.octets[y], w in f) {
            if (b = f[w], m && b !== 0)
              return null;
            b !== 8 && (m = !0), d += b;
          } else
            return null;
        return 32 - d;
      }, c.prototype.range = function() {
        return g.subnetMatch(this, this.SpecialRanges);
      }, c.prototype.toByteArray = function() {
        return this.octets.slice(0);
      }, c.prototype.toIPv4MappedAddress = function() {
        return g.IPv6.parse(`::ffff:${this.toString()}`);
      }, c.prototype.toNormalizedString = function() {
        return this.toString();
      }, c.prototype.toString = function() {
        return this.octets.join(".");
      }, c;
    })(), g.IPv4.broadcastAddressFromCIDR = function(c) {
      try {
        let d = this.parseCIDR(c), m = d[0].toByteArray(), f = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), y = [], w = 0;
        for (; w < 4; )
          y.push(parseInt(m[w], 10) | parseInt(f[w], 10) ^ 255), w++;
        return new this(y);
      } catch (d) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: d });
      }
    }, g.IPv4.isIPv4 = function(c) {
      return this.parser(c) !== null;
    }, g.IPv4.isValid = function(c) {
      try {
        return new this(this.parser(c)), !0;
      } catch {
        return !1;
      }
    }, g.IPv4.isValidCIDR = function(c) {
      try {
        return this.parseCIDR(c), !0;
      } catch {
        return !1;
      }
    }, g.IPv4.isValidFourPartDecimal = function(c) {
      return !!(g.IPv4.isValid(c) && c.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/));
    }, g.IPv4.isValidCIDRFourPartDecimal = function(c) {
      let d = c.match(/^(.+)\/(\d+)$/);
      return !g.IPv4.isValidCIDR(c) || !d ? !1 : g.IPv4.isValidFourPartDecimal(d[1]);
    }, g.IPv4.networkAddressFromCIDR = function(c) {
      let d, m, f, y, w;
      try {
        for (d = this.parseCIDR(c), f = d[0].toByteArray(), w = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), y = [], m = 0; m < 4; )
          y.push(parseInt(f[m], 10) & parseInt(w[m], 10)), m++;
        return new this(y);
      } catch (b) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: b });
      }
    }, g.IPv4.parse = function(c) {
      let d = this.parser(c);
      if (d === null)
        throw new Error("ipaddr: string is not formatted like an IPv4 Address");
      return new this(d);
    }, g.IPv4.parseCIDR = function(c) {
      let d;
      if (d = c.match(/^(.+)\/(\d+)$/)) {
        let m = parseInt(d[2]);
        if (m >= 0 && m <= 32) {
          let f = [this.parse(d[1]), m];
          return Object.defineProperty(f, "toString", {
            value: function() {
              return this.join("/");
            }
          }), f;
        }
      }
      throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
    }, g.IPv4.parser = function(c) {
      let d, m, f;
      if (d = c.match(n.fourOctet))
        return (function() {
          let y = d.slice(1, 6), w = [];
          for (let b = 0; b < y.length; b++)
            m = y[b], w.push(h(m));
          return w;
        })();
      if (d = c.match(n.longValue)) {
        if (f = h(d[1]), f > 4294967295 || f < 0)
          throw new Error("ipaddr: address outside defined range");
        return (function() {
          let y = [], w;
          for (w = 0; w <= 24; w += 8)
            y.push(f >> w & 255);
          return y;
        })().reverse();
      } else return (d = c.match(n.twoOctet)) ? (function() {
        let y = d.slice(1, 4), w = [];
        if (f = h(y[1]), f > 16777215 || f < 0)
          throw new Error("ipaddr: address outside defined range");
        return w.push(h(y[0])), w.push(f >> 16 & 255), w.push(f >> 8 & 255), w.push(f & 255), w;
      })() : (d = c.match(n.threeOctet)) ? (function() {
        let y = d.slice(1, 5), w = [];
        if (f = h(y[2]), f > 65535 || f < 0)
          throw new Error("ipaddr: address outside defined range");
        return w.push(h(y[0])), w.push(h(y[1])), w.push(f >> 8 & 255), w.push(f & 255), w;
      })() : null;
    }, g.IPv4.subnetMaskFromPrefixLength = function(c) {
      if (c = parseInt(c), Number.isNaN(c) || c < 0 || c > 32)
        throw new Error("ipaddr: invalid IPv4 prefix length");
      let d = [0, 0, 0, 0], m = 0, f = Math.floor(c / 8);
      for (; m < f; )
        d[m] = 255, m++;
      return f < 4 && (d[f] = Math.pow(2, c % 8) - 1 << 8 - c % 8), new this(d);
    }, g.IPv6 = (function() {
      function c(d, m) {
        let f, y;
        if (d.length === 16)
          for (this.parts = [], f = 0; f <= 14; f += 2)
            this.parts.push(d[f] << 8 | d[f + 1]);
        else if (d.length === 8)
          this.parts = d;
        else
          throw new Error("ipaddr: ipv6 part count should be 8 or 16");
        for (f = 0; f < this.parts.length; f++)
          if (y = this.parts[f], !(0 <= y && y <= 65535))
            throw new Error("ipaddr: ipv6 part should fit in 16 bits");
        m && (this.zoneId = m);
      }
      return c.prototype.SpecialRanges = {
        // RFC4291, here and after
        unspecified: [new c([0, 0, 0, 0, 0, 0, 0, 0]), 128],
        linkLocal: [new c([65152, 0, 0, 0, 0, 0, 0, 0]), 10],
        multicast: [new c([65280, 0, 0, 0, 0, 0, 0, 0]), 8],
        loopback: [new c([0, 0, 0, 0, 0, 0, 0, 1]), 128],
        uniqueLocal: [new c([64512, 0, 0, 0, 0, 0, 0, 0]), 7],
        ipv4Mapped: [new c([0, 0, 0, 0, 0, 65535, 0, 0]), 96],
        // RFC3879
        deprecatedSiteLocal: [new c([65216, 0, 0, 0, 0, 0, 0, 0]), 10],
        // RFC6666
        discard: [new c([256, 0, 0, 0, 0, 0, 0, 0]), 64],
        // RFC6145
        rfc6145: [new c([0, 0, 0, 0, 65535, 0, 0, 0]), 96],
        rfc6052: [
          // RFC6052
          [new c([100, 65435, 0, 0, 0, 0, 0, 0]), 96],
          // RFC8215
          [new c([100, 65435, 1, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC3056
        "6to4": [new c([8194, 0, 0, 0, 0, 0, 0, 0]), 16],
        // RFC6052, RFC6146
        teredo: [new c([8193, 0, 0, 0, 0, 0, 0, 0]), 32],
        // RFC5180
        benchmarking: [new c([8193, 2, 0, 0, 0, 0, 0, 0]), 48],
        // RFC7450
        amt: [new c([8193, 3, 0, 0, 0, 0, 0, 0]), 32],
        as112v6: [
          // RFC7535
          [new c([8193, 4, 274, 0, 0, 0, 0, 0]), 48],
          // RFC7534
          [new c([9760, 79, 32768, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC4843
        deprecatedOrchid: [new c([8193, 16, 0, 0, 0, 0, 0, 0]), 28],
        // RFC7343
        orchid2: [new c([8193, 32, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9374
        droneRemoteIdProtocolEntityTags: [new c([8193, 48, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9602
        segmentRouting: [new c([24320, 0, 0, 0, 0, 0, 0, 0]), 16],
        reserved: [
          // RFC3849
          [new c([8193, 0, 0, 0, 0, 0, 0, 0]), 23],
          // RFC2928
          [new c([8193, 3512, 0, 0, 0, 0, 0, 0]), 32],
          // RFC9637
          [new c([16383, 0, 0, 0, 0, 0, 0, 0]), 20]
        ]
      }, c.prototype.isIPv4MappedAddress = function() {
        return this.range() === "ipv4Mapped";
      }, c.prototype.kind = function() {
        return "ipv6";
      }, c.prototype.match = function(d, m) {
        let f;
        if (m === void 0 && (f = d, d = f[0], m = f[1]), d.kind() !== "ipv6")
          throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
        return u(this.parts, d.parts, 16, m);
      }, c.prototype.prefixLengthFromSubnetMask = function() {
        let d = 0, m = !1, f = {
          0: 16,
          32768: 15,
          49152: 14,
          57344: 13,
          61440: 12,
          63488: 11,
          64512: 10,
          65024: 9,
          65280: 8,
          65408: 7,
          65472: 6,
          65504: 5,
          65520: 4,
          65528: 3,
          65532: 2,
          65534: 1,
          65535: 0
        }, y, w;
        for (let b = 7; b >= 0; b -= 1)
          if (y = this.parts[b], y in f) {
            if (w = f[y], m && w !== 0)
              return null;
            w !== 16 && (m = !0), d += w;
          } else
            return null;
        return 128 - d;
      }, c.prototype.range = function() {
        return g.subnetMatch(this, this.SpecialRanges);
      }, c.prototype.toByteArray = function() {
        let d, m = [], f = this.parts;
        for (let y = 0; y < f.length; y++)
          d = f[y], m.push(d >> 8), m.push(d & 255);
        return m;
      }, c.prototype.toFixedLengthString = function() {
        let d = (function() {
          let f = [];
          for (let y = 0; y < this.parts.length; y++)
            f.push(p(this.parts[y].toString(16), 4));
          return f;
        }).call(this).join(":"), m = "";
        return this.zoneId && (m = `%${this.zoneId}`), d + m;
      }, c.prototype.toIPv4Address = function() {
        if (!this.isIPv4MappedAddress())
          throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
        let d = this.parts.slice(-2), m = d[0], f = d[1];
        return new g.IPv4([m >> 8, m & 255, f >> 8, f & 255]);
      }, c.prototype.toNormalizedString = function() {
        let d = (function() {
          let f = [];
          for (let y = 0; y < this.parts.length; y++)
            f.push(this.parts[y].toString(16));
          return f;
        }).call(this).join(":"), m = "";
        return this.zoneId && (m = `%${this.zoneId}`), d + m;
      }, c.prototype.toRFC5952String = function() {
        let d = /((^|:)(0(:|$)){2,})/g, m = "";
        this.zoneId && (m = `%${this.zoneId}`);
        let f = this.toNormalizedString(), y = f.slice(0, f.length - m.length), w = 0, b = -1, S = -1, k;
        for (; k = d.exec(y); ) {
          let R = (k[0].match(/0/g) || []).length;
          R > S && (S = R, w = k.index, b = k[0].length);
        }
        return b < 0 ? y + m : `${y.substring(0, w)}::${y.substring(w + b)}${m}`;
      }, c.prototype.toString = function() {
        return this.toRFC5952String();
      }, c;
    })(), g.IPv6.broadcastAddressFromCIDR = function(c) {
      try {
        let d = this.parseCIDR(c), m = d[0].toByteArray(), f = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), y = [], w = 0;
        for (; w < 16; )
          y.push(parseInt(m[w], 10) | parseInt(f[w], 10) ^ 255), w++;
        return new this(y);
      } catch (d) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: d });
      }
    }, g.IPv6.isIPv6 = function(c) {
      return this.parser(c) !== null;
    }, g.IPv6.isValid = function(c) {
      if (typeof c == "string" && c.indexOf(":") === -1)
        return !1;
      try {
        let d = this.parser(c);
        return new this(d.parts, d.zoneId), !0;
      } catch {
        return !1;
      }
    }, g.IPv6.isValidCIDR = function(c) {
      if (typeof c == "string" && c.indexOf(":") === -1)
        return !1;
      try {
        return this.parseCIDR(c), !0;
      } catch {
        return !1;
      }
    }, g.IPv6.networkAddressFromCIDR = function(c) {
      let d, m, f, y, w;
      try {
        for (d = this.parseCIDR(c), f = d[0].toByteArray(), w = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), y = [], m = 0; m < 16; )
          y.push(parseInt(f[m], 10) & parseInt(w[m], 10)), m++;
        return new this(y);
      } catch (b) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: b });
      }
    }, g.IPv6.parse = function(c) {
      let d = this.parser(c);
      if (d === null)
        throw new Error("ipaddr: string is not formatted like an IPv6 Address");
      return new this(d.parts, d.zoneId);
    }, g.IPv6.parseCIDR = function(c) {
      let d, m, f;
      if ((m = c.match(/^(.+)\/(\d+)$/)) && (d = parseInt(m[2]), d >= 0 && d <= 128))
        return f = [this.parse(m[1]), d], Object.defineProperty(f, "toString", {
          value: function() {
            return this.join("/");
          }
        }), f;
      throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
    }, g.IPv6.parser = function(c) {
      let d, m, f, y, w, b;
      if (f = c.match(a.deprecatedTransitional))
        return this.parser(`::ffff:${f[1]}`);
      if (a.native.test(c))
        return l(c, 8);
      if ((f = c.match(a.transitional)) && (b = f[6] || "", d = f[1], f[1].endsWith("::") || (d = d.slice(0, -1)), d = l(d + b, 6), d && d.parts)) {
        for (w = [
          parseInt(f[2]),
          parseInt(f[3]),
          parseInt(f[4]),
          parseInt(f[5])
        ], m = 0; m < w.length; m++)
          if (y = w[m], !(0 <= y && y <= 255))
            return null;
        return d.parts.push(w[0] << 8 | w[1]), d.parts.push(w[2] << 8 | w[3]), {
          parts: d.parts,
          zoneId: d.zoneId
        };
      }
      return null;
    }, g.IPv6.subnetMaskFromPrefixLength = function(c) {
      if (c = parseInt(c), Number.isNaN(c) || c < 0 || c > 128)
        throw new Error("ipaddr: invalid IPv6 prefix length");
      let d = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], m = 0, f = Math.floor(c / 8);
      for (; m < f; )
        d[m] = 255, m++;
      return f < 16 && (d[f] = Math.pow(2, c % 8) - 1 << 8 - c % 8), new this(d);
    }, g.fromByteArray = function(c) {
      let d = c.length;
      if (d === 4)
        return new g.IPv4(c);
      if (d === 16)
        return new g.IPv6(c);
      throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
    }, g.isValid = function(c) {
      return g.IPv6.isValid(c) || g.IPv4.isValid(c);
    }, g.isValidCIDR = function(c) {
      return g.IPv6.isValidCIDR(c) || g.IPv4.isValidCIDR(c);
    }, g.parse = function(c) {
      if (g.IPv6.isValid(c))
        return g.IPv6.parse(c);
      if (g.IPv4.isValid(c))
        return g.IPv4.parse(c);
      throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
    }, g.parseCIDR = function(c) {
      try {
        return g.IPv6.parseCIDR(c);
      } catch {
        try {
          return g.IPv4.parseCIDR(c);
        } catch (d) {
          throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: d });
        }
      }
    }, g.process = function(c) {
      let d = this.parse(c);
      return d.kind() === "ipv6" && d.isIPv4MappedAddress() ? d.toIPv4Address() : d;
    }, g.subnetMatch = function(c, d, m) {
      let f, y, w, b;
      m == null && (m = "unicast");
      for (y in d)
        if (Object.prototype.hasOwnProperty.call(d, y)) {
          for (w = d[y], w[0] && !(w[0] instanceof Array) && (w = [w]), f = 0; f < w.length; f++)
            if (b = w[f], c.kind() === b[0].kind() && c.match.apply(c, b))
              return y;
        }
      return m;
    }, typeof Bt < "u" && Bt.exports ? Bt.exports = g : e.ipaddr = g;
  })(ss);
});

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
D();

// openclaw/ui/src/components/browser/browser-client.ts
oe();
D();
F();

// openclaw/ui/src/api/gateway.ts
D();
Yt();

// openclaw/ui/src/app/native-gateway-auth.ts
D();
ht();

// openclaw/ui/src/lib/uuid.ts
Jt();

// openclaw/ui/src/api/gateway.ts
ht();
mn();

// openclaw/ui/src/api/gateway-browser-socket.ts
ht();

// openclaw/ui/src/api/gateway-chat-events.ts
D();

// openclaw/packages/session-url-contract/src/index.ts
ct();
F();

// openclaw/packages/session-url-contract/src/grammar.ts
F();

// openclaw/packages/session-url-contract/src/session-key.ts
ct();
F();

// openclaw/packages/session-url-contract/src/focus.ts
F();

// openclaw/packages/session-url-contract/src/share.ts
var fc = Object.freeze([
  "activity",
  "agents",
  "ai-agents",
  "appearance",
  "approve",
  "apps",
  "ask",
  "automation",
  "automations",
  "channels",
  "chat",
  "communications",
  "config",
  "cron",
  "custodian",
  "dashboard",
  "dashboards",
  "debug",
  "focus",
  "infrastructure",
  "lobsterdex",
  "logs",
  "mcp",
  "meetings",
  "memory-import",
  "model-providers",
  "model-setup",
  "new",
  "nodes",
  "plugin",
  "plugins",
  "portals",
  "profile",
  "sessions",
  "settings",
  "share",
  "skills",
  "systems",
  "terminal",
  "usage",
  "workboard",
  "worktrees"
]);

// openclaw/ui/src/api/gateway-session-row-events.ts
D();

// openclaw/src/shared/device-bootstrap-profile.ts
cn();
var vt = [
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write"
], Ag = new Set(vt), yn = [
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write"
], _g = new Set(
  yn
), Mo = [
  "operator.admin",
  ...vt
], Ig = new Set(Mo);
var Pg = {
  // QR/setup-code bootstrap must hand off both tokens for native onboarding:
  // iOS/Android suppress the operator loop while bootstrap auth is active and
  // only start it after persisting this bounded operator token.
  roles: ["node", "operator"],
  scopes: [...vt]
}, Dg = {
  roles: ["operator"],
  scopes: [...yn],
  purpose: "control-ui-owner"
}, Mg = {
  roles: ["node", "operator"],
  scopes: [...Mo],
  purpose: "mobile-full"
};

// openclaw/ui/src/i18n/locales/en-agents.ts
var Oo = {
  menuLabel: "Agent menu",
  agents: "Agents",
  showAll: "Show all",
  seeAllAgents: "See all agents",
  namedSettings: "{name} settings",
  agentSettings: "Agent settings",
  newConversation: "New conversation",
  workspaceMenuLabel: "Workspace menu",
  switchAgent: "Switch agent",
  working: "Working\u2026",
  ready: "Ready to chat",
  whatCanAgentDo: "What can {name} do?",
  help: "Help",
  getHelp: "Get help",
  getApps: "Get the apps",
  discord: "Discord community",
  viewChangelog: "View changelog"
}, No = {
  label: "Agent",
  allAgents: "All agents"
}, Uo = {
  pinToSwitcher: "Pin to switcher",
  unpinFromSwitcher: "Unpin from switcher"
}, Fo = {
  title: "Identity",
  subtitle: "Name, emoji, and avatar shown in chats and the sidebar.",
  name: "Display name",
  namePlaceholder: "Agent name",
  emoji: "Emoji",
  chooseEmoji: "Choose emoji",
  searchEmoji: "Search emoji\u2026",
  noEmojiMatches: "No matching emoji",
  chooseAvatar: "Edit avatar",
  avatarPicker: "Avatar picker",
  avatarPreview: "Avatar preview",
  avatarSource: "Avatar source",
  avatarBot: "Blobster",
  avatarGenerate: "Generate",
  avatarUpload: "Upload",
  avatarReset: "Reset",
  avatarPresets: "All Blobster presets",
  avatarPrompt: "Describe your blobster...",
  avatarUse: "Use avatar",
  avatarDiscard: "Discard",
  avatarRegenerate: "Generate again",
  avatarGenerating: "Generating...",
  avatarPreparing: "Preparing avatar\u2026",
  avatarPermission: "Connect with permission to update agent identity to generate an avatar.",
  avatarContextChanged: "The selected agent or connection changed. Generate an avatar again.",
  avatarUploadHint: "Choose an image up to 2 MB. It will be resized for chats and the sidebar.",
  chooseImage: "Choose image\u2026",
  replaceImage: "Replace image\u2026",
  imageUnusable: "That image can't be used. Pick an image file up to 2 MB.",
  imageTooDetailed: "That image is too detailed to store as an avatar. Try a simpler image, or set a workspace image path with openclaw agents set-identity --agent <id> --avatar <path>.",
  fileHint: "Saving mirrors identity fields to IDENTITY.md; configured values take precedence."
};

// openclaw/ui/src/i18n/locales/en.ts
var Ke = {
  pluginUi: {
    sessionRecentMessages: "Recent messages",
    sessionHistoryUnavailable: "Session history could not be loaded. Try again.",
    sessionHistoryEmpty: "No recent messages.",
    customize: "Customize UI",
    selectionScope: "Choose views for this browser window. Built-in views are always available.",
    builtin: "Built-in view",
    retryView: "Retry plugin view",
    reload: "Reload plugin UI",
    dashboardTitle: "Session dashboard",
    dashboardEmpty: "This session has no dashboard widgets yet.",
    customPluginsDisabled: "Custom plugin UI is off",
    customPluginsEnableHint: "Enable Custom plugin UI in Labs.",
    openLabs: "Open Labs",
    surface: {
      "session-list": "Session list",
      composer: "Composer",
      workspace: "Workspace",
      transcript: "Transcript",
      "tool-result": "Tool results"
    }
  },
  capacityMeter: {
    workerSlots: "{used} of {total} slots busy",
    unavailable: "Slot utilization unavailable",
    execHost: "Codex exec"
  },
  agentsHome: {},
  common: {
    uploadsDisabled: "File and image uploads are disabled.",
    health: "Health",
    ok: "OK",
    yes: "Yes",
    no: "No",
    default: "Default",
    active: "Active",
    loading: "Loading\u2026",
    gatewayStarting: "Gateway starting\u2026",
    refreshing: "Refreshing\u2026",
    offline: "Offline",
    connect: "Connect",
    connected: "Connected",
    refresh: "Refresh",
    retry: "Retry",
    staleData: "Showing stale data.",
    reload: "Reload",
    reset: "Reset",
    restore: "Restore",
    unarchive: "Unarchive",
    undo: "Undo",
    probe: "Check connection",
    call: "Call",
    confirm: "Confirm",
    dontAskAgain: "Don't ask me again",
    cancel: "Cancel",
    close: "Close",
    previous: "Previous",
    next: "Next",
    continue: "Continue",
    back: "Back",
    create: "Create",
    copy: "Copy",
    copied: "Copied!",
    copyFailed: "Copy failed",
    copyCode: "Copy code",
    copyTable: "Copy table",
    expandTable: "Expand table",
    expandedTable: "Expanded table",
    closeTable: "Close expanded table",
    resizeSplitView: "Resize split view",
    delete: "Delete",
    remove: "Remove",
    dismiss: "Dismiss",
    dismissAndDontShowAgain: "Dismiss and don't show again",
    unselect: "Unselect",
    enabled: "Enabled",
    disabled: "Disabled",
    failed: "Failed",
    none: "none",
    na: "n/a",
    never: "never",
    justNow: "just now",
    now: "now",
    unknown: "Unknown",
    configured: "Configured",
    running: "Running",
    queued: "Queued",
    completed: "Completed",
    cancelled: "Cancelled",
    linked: "Linked",
    mode: "Mode",
    system: "System",
    light: "Light",
    dark: "Dark",
    baseUrl: "Base URL",
    lastStart: "Last start",
    lastProbe: "Last connection check",
    lastConnect: "Last connect",
    lastMessage: "Last message",
    authAge: "Auth age",
    credential: "Credential",
    audience: "Audience",
    publicKey: "Public Key",
    probeOk: "Connection check passed",
    probeFailed: "Connection check failed",
    reloadConfig: "Reload Config",
    multiSelect: {
      addCustom: "Add \u201C{value}\u201D",
      noMatches: "No matches",
      remove: "Remove {value}"
    },
    loadConfig: "Load config",
    loadApprovals: "Load approvals",
    settingsSections: "Settings sections",
    version: "Version",
    docs: "Docs",
    learnMore: "Learn more",
    colorMode: "Color mode",
    colorModeOption: "Color mode: {mode}",
    search: "Search",
    pickerNoMatches: "No matches",
    save: "Save",
    saving: "Saving\u2026",
    saveAndPublish: "Save & Publish",
    importing: "Importing\u2026",
    importFromRelays: "Import from Relays",
    showAdvanced: "Show Advanced",
    hideAdvanced: "Hide Advanced",
    unsavedChanges: "You have unsaved changes",
    working: "Working\u2026",
    showQr: "Show QR",
    relink: "Relink",
    waitForScan: "Wait for scan",
    logout: "Logout",
    skipToMainContent: "Skip to main content"
  },
  focus: {
    unsupported: "This focused view is not supported."
  },
  shortcutsOverlay: { title: "Keyboard shortcuts" },
  optionCard: {
    recommended: "Recommended",
    skip: "Skip for now"
  },
  nativeConversation: {
    openDashboardFailed: "Couldn't open that page in the Dashboard"
  },
  nativeLinkMenu: {
    label: "Link actions",
    openInline: "Open in Browser Panel",
    openExternal: "Open in Default Browser",
    copy: "Copy Link"
  },
  browserLinkPreferences: {
    openInControlUi: "Open links in Control UI browser"
  },
  filePreview: {
    bundle: {},
    label: "Support files"
  },
  mcpApp: {},
  sessionHovercard: {
    ariaLabel: "Session information",
    linkedChannel: "Linked to {channel}",
    moreParticipants: "+{count}",
    moreParticipantsLabel: "{count} more participants",
    projectLabel: "Project",
    workspaceLabel: "Workspace",
    branchLabel: "Branch",
    runsOn: "Runs on {providerId} \xB7 {profileId}",
    machineLabel: "Machine",
    machineCpu: "{cpu} vCPU",
    machineMemory: "{memory} GB",
    more: "+{count} more",
    changedFile: "{count} file",
    changedFiles: "{count} files",
    states: {},
    checks: {}
  },
  sessionProgressCard: {
    title: "Progress",
    composerTitle: "Task progress",
    stepCount: "Step {current} of {total}",
    hide: "Hide this card",
    noteLabel: "Progress note",
    dismiss: "Dismiss progress card",
    clearSaved: "Clear saved progress for everyone",
    clearFailed: "Could not clear saved progress card.",
    refresh: {
      label: "Refresh task progress",
      retry: "Retry progress refresh",
      pending: "Refreshing task progress\u2026",
      failed: "Could not refresh. Previous update kept.",
      timeout: "No new update yet. The request may still be running.",
      updated: "Task progress updated"
    },
    widgetLabel: "Session progress",
    widgetLoading: "Loading session progress\u2026",
    widgetEmpty: "No progress card yet",
    widgetUnavailable: "Session progress is unavailable.",
    widgetAccessDenied: "Select a session you can access or change sharing for this session.",
    countLabel: "{completed} of {total} completed",
    activity: {
      updated: "Updated {time}",
      completed: "Completed {time}",
      failed: "Failed {time}",
      stopped: "Stopped {time}"
    },
    outcome: {
      completed: "Completed",
      failed: "Failed",
      stopped: "Stopped"
    },
    stepLabel: "{step}, {status}",
    status: {
      completed: "completed",
      failed: "failed",
      inProgress: "in progress",
      paused: "paused",
      pending: "pending",
      stopped: "stopped"
    },
    receipt: {
      updating: "Updating progress",
      failed: "Progress update failed",
      skipped: "Progress update skipped",
      updated: "Progress updated \u2014 {completed}/{total} \xB7 {current}",
      noteUpdated: "Progress note updated",
      cleared: "Progress cleared"
    }
  },
  channels: {
    lastError: "Last error",
    refreshingStaleSnapshot: "Refreshing channel status in the background; showing the last successful snapshot.",
    hub: {
      connectedTitle: "Connected channels",
      addTitle: "Add a channel",
      addSubtitle: "Pick a service and follow the guided setup.",
      updatedAgo: "Updated {ago}",
      noneConnected: "No channels connected yet. Pick one below to get started.",
      partialSnapshot: "Some channel checks did not finish before the UI budget.",
      stateRunning: "Running",
      stateConfigured: "Configured",
      stateAttention: "Needs attention",
      setUp: "Set up",
      guidedSetup: "Guided step-by-step setup",
      openDetails: "Open details",
      lastMessageAgo: "Last message {ago}",
      browseAllTitle: "More channels\u2026",
      browseAllSubtitle: "Browse every available channel, including installable plugins.",
      runSetup: "Run setup",
      adminRequired: "Browsing only. Channel setup requires operator.admin access.",
      saveBeforeSetup: "You have unsaved channel config changes. Save or reload them before running guided setup."
    },
    pairing: {
      title: "DM access requests",
      subtitle: "Review people waiting to send direct messages to pairing-protected channels.",
      channelFilter: "Channel",
      accountFilter: "Account",
      allChannels: "All channels",
      allAccounts: "All accounts",
      approve: "Approve",
      dismiss: "Dismiss",
      approveAria: "Approve {sender} for {channel}, account {account}",
      dismissAria: "Dismiss {sender} for {channel}, account {account}",
      requested: "Requested {ago}",
      expires: "Expires {ago}",
      senderDetails: "Sender details",
      missingPermission: "This connection does not have operator.pairing access, so DM requests cannot be reviewed.",
      noAccounts: "No configured channel accounts use DM sender pairing.",
      noRequests: "No pending DM access requests.",
      noFilteredRequests: "No pending requests match these filters.",
      limits: "Requests expire after {minutes} minutes. Each channel account can hold up to {count} pending requests.",
      detailTitle: "DM access",
      detailSubtitle: "People must be approved before their direct messages reach the agent.",
      pendingCount: "{count} pending",
      noPending: "No pending requests",
      review: "Review requests",
      approveDialogTitle: "Approve DM access",
      dismissDialogTitle: "Dismiss DM access request",
      approveExplanation: "This lets the sender talk to the agent in direct messages. It does not grant group access.",
      dismissExplanation: "This removes the current request but does not block the sender. They can request access again later.",
      notifyRequester: "Notify the requester after approval",
      makeCommandOwner: "Also make this sender the first command owner",
      commandOwnerHelp: "Command owners can run privileged commands and approve dangerous actions. This option is only available while no owner is configured.",
      commandOwnerNeedsAdmin: "No command owner is configured. This connection needs operator.admin to assign the first owner.",
      approvedNotice: "DM access approved.",
      approvedOwnerNotice: "DM access approved and the first command owner was configured.",
      approvedNotificationFailedNotice: "DM access approved, but the requester notification could not be delivered.",
      approvedOwnerFailedNotice: "DM access approved, but the first command owner could not be configured.",
      approvedFollowupsFailedNotice: "DM access approved, but requester notification and command-owner setup both failed.",
      dismissedNotice: "DM access request dismissed. The sender can request access again."
    },
    setup: {
      dialogLabel: "Set up {channel}",
      title: "Set up {channel}",
      genericTitle: "a channel",
      subtitle: "Guided channel setup",
      starting: "Starting setup\u2026",
      working: "Working\u2026",
      sessionExpired: "This setup session expired after the Gateway restarted. Close this dialog, then start channel setup again.",
      continue: "Continue",
      finish: "Finish",
      copyText: "Copy",
      openLink: "Open link",
      viewDocs: "View docs",
      doneTitle: "Channel configured",
      doneBody: "Configuration saved. The gateway reloads the channel automatically; check its card for live status.",
      doneNoChangesTitle: "No changes made",
      doneNoChangesBody: "Setup finished without configuring a channel. Nothing was saved.",
      whatsappScanTitle: "Link WhatsApp by scanning the QR code",
      whatsappScanHelp: "On your phone, open WhatsApp \u2192 Settings \u2192 Linked devices \u2192 Link a device, then scan this code.",
      whatsappQrLoading: "Generating QR code\u2026",
      whatsappQrHint: "Click Show QR to generate a pairing code.",
      whatsappQrAlt: "WhatsApp QR",
      whatsappLinked: "WhatsApp is linked and ready.",
      regenerateQr: "New QR code",
      linkLater: "Link later"
    },
    config: {
      schemaUnavailable: "Schema unavailable. Use Raw.",
      channelSchemaUnavailable: "Channel config schema unavailable.",
      loadingSchema: "Loading config schema\u2026"
    },
    generic: {
      subtitle: "Channel status and configuration."
    },
    discord: {
      title: "Discord",
      subtitle: "Bot status and channel configuration."
    },
    googleChat: {
      title: "Google Chat",
      subtitle: "Chat API webhook status and channel configuration."
    },
    imessage: {
      title: "iMessage",
      subtitle: "macOS bridge status and channel configuration."
    },
    signal: {
      title: "Signal",
      subtitle: "signal-cli status and channel configuration."
    },
    slack: {
      title: "Slack",
      subtitle: "Socket mode status and channel configuration."
    },
    telegram: {
      title: "Telegram",
      subtitle: "Bot status and channel configuration."
    },
    whatsapp: {
      title: "WhatsApp",
      subtitle: "Link WhatsApp Web and monitor connection health.",
      phoneNumber: "Phone number",
      loggedOut: "Logged out.",
      logoutConfirmTitle: "Log out of WhatsApp account {accountId}?",
      logoutConfirmMessage: "Logging out of account {accountId} stops its listener and deletes its saved credentials.",
      logoutNotCleared: "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup."
    },
    nostr: {
      title: "Nostr",
      subtitle: "Decentralized DMs via Nostr relays (NIP-04).",
      profile: "Profile",
      editProfile: "Edit Profile",
      profilePicture: "Profile picture",
      noProfile: "No profile set.",
      noProfileHint: 'Click "Edit Profile" to add your name, bio, and avatar.',
      name: "Name",
      displayName: "Display Name",
      about: "About",
      advanced: "Advanced",
      profilePicturePreview: "Profile picture preview",
      account: "Account",
      username: "Username",
      usernameHelp: "Short username (e.g., satoshi)",
      bio: "Bio",
      bioPlaceholder: "Tell people about yourself...",
      bioHelp: "A brief bio or description",
      displayNameHelp: "Your full display name",
      avatarUrl: "Avatar URL",
      avatarHelp: "HTTPS URL to your profile picture",
      bannerUrl: "Banner URL",
      bannerHelp: "HTTPS URL to a banner image",
      website: "Website",
      websiteHelp: "Your personal website",
      nip05Identifier: "NIP-05 Identifier",
      nip05Help: "Verifiable identifier (e.g., you@domain.com)",
      lightningAddress: "Lightning Address",
      lightningHelp: "Lightning address for tips (LUD-16)",
      placeholders: {
        username: "satoshi",
        displayName: "Satoshi Nakamoto",
        avatarUrl: "https://example.com/avatar.jpg",
        bannerUrl: "https://example.com/banner.jpg",
        website: "https://example.com",
        nip05: "you@example.com",
        lightningAddress: "you@getalby.com"
      },
      notices: {
        timeout: "Request timed out after 30 seconds; the server may still have applied the change \u2014 check the profile before retrying.",
        operationFailed: "{prefix}: {error}",
        updateFailed: "Profile update failed",
        publishFailed: "Profile publish failed on all relays.",
        published: "Profile published to relays.",
        importFailed: "Profile import failed",
        importedFromRelays: "Profile imported from relays. Review and publish.",
        imported: "Profile imported. Review and publish."
      }
    }
  },
  agentStartup: {
    title: "Starting up",
    description: "The agent is getting ready. This view will load automatically.",
    short: "Starting up\u2026"
  },
  lazyView: {
    errorTitle: "Panel failed to load",
    genericSubtitle: "Something went wrong while loading this panel.",
    staleTitle: "This view could not load",
    staleSubtitle: "Some interface files could not be downloaded. Check your connection, then reload.",
    reloading: "Reloading\u2026",
    retry: "Retry",
    stylesFailed: "Styles failed to load, so the page may look broken."
  },
  communityInvite: {
    title: "Community",
    body: "Connect, ask questions, share what you build.",
    discord: "Chat with the community",
    reddit: "Discussions and ideas",
    x: "News and updates",
    opensNewTab: "Links open in a new tab.",
    joinPlatform: "Join the OpenClaw community on {platform}",
    followPlatform: "Follow OpenClaw on {platform}"
  },
  updates: {
    adminRequired: "Administrator access is required to change update settings or start an update.",
    campaign: {
      countdown: "Updating in {time}",
      waitingForIdle: "Waiting for active work \xB7 forced update in {time}",
      held: "Update held \xB7 resumes in {time}",
      applying: "Applying update\u2026"
    },
    holdOneHour: "Hold 1 h",
    reviewUpdate: "Review update",
    run: {
      title: "Update progress",
      phases: "Update phases",
      steps: "Installation steps",
      details: "Step details",
      noDetails: "No step details recorded yet.",
      verification: "Verification checks",
      report: "Update report",
      restarting: "Gateway restarting\u2026",
      reconnecting: "Reconnecting automatically. Update progress is saved on the gateway.",
      progress: "{completed} of {total} phases complete",
      phase: {
        requested: "Requested",
        staging: "Staging",
        validating: "Validating",
        repairing: "Repairing",
        activating: "Activating",
        restarting: "Restarting",
        verifying: "Verifying",
        finished: "Finished"
      },
      step: {
        completed: "Complete",
        in_progress: "In progress",
        pending: "Pending",
        failed: "Failed",
        skipped: "Skipped"
      },
      oracle: {
        service: "Service",
        version: "Version",
        plugins: "Plugins",
        channels: "Channels",
        inference: "Inference"
      },
      oracleState: {
        pass: "Passed",
        warn: "Not verified",
        fail: "Failed",
        pending: "Pending"
      }
    },
    confirm: {
      action: "Update and restart"
    },
    target: {
      version: "v{version}",
      commitBehind: "{count} commit behind",
      commitsBehind: "{count} commits behind",
      viewChanges: "Compare on GitHub"
    },
    sidebar: {
      campaignTarget: "{status} \xB7 {target}",
      checking: "Checking for updates\u2026",
      checkFailed: "Could not check the latest update. Try again.",
      updating: "Updating Gateway\u2026",
      availableTitle: "Update available",
      availableBadge: "Available",
      availableSummary: "A newer revision is ready.",
      blockedTitle: "Update blocked",
      blockedSummary: "The selected revision could not be applied to this checkout.",
      blockedWaiting: "Blocked \xB7 waiting for active work \xB7 {target}",
      waitingForIdle: "Waiting for active work"
    },
    dialog: {
      disconnected: "The Gateway disconnected during the update. This page reconnects on its own. If it stays disconnected, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair.",
      restarting: "The Gateway is restarting. This page disconnects and reconnects on its own. If it stays disconnected, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair."
    },
    channel: {},
    installKind: {},
    page: {},
    coalescedRestart: "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
    error: "Update error: {error}",
    checkError: "Could not check for updates: {error}",
    status: "Update {status}: {reason}. {guidance}",
    verificationFailedWithIdentity: "Update finished, but the running install does not match the expected revision. Expected {expected}, running {actual}. Run `openclaw triage` on the Gateway host before retrying.",
    handoffTimeout: "Update completion was not confirmed. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
    outcomeUnknown: "The update outcome is unknown. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
    triage: {
      hostHint: "If Ask OpenClaw is unavailable, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair. Diagnose the cause before retrying."
    },
    report: {},
    failureReasons: {
      dirty: "Commit or stash changes, then retry.",
      noUpstream: "Set an upstream branch, then retry.",
      notGitInstall: "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      notOpenclawRoot: "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      depsInstallFailed: "Dependency install failed. Fix the install error and retry.",
      buildFailed: "Build failed. Fix the build error and retry.",
      buildDirty: "The selected revision's build changed checkout files. Retry with a revision that includes its generated artifacts.",
      uiBuildFailed: "The control UI rebuild failed. Fix the UI build error and retry.",
      globalInstallFailed: "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      restartDisabled: "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry.",
      restartUnavailable: "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      externalSupervisorUpdateRequired: "This Gateway is managed by an external supervisor. Use your server or deployment's update workflow to update OpenClaw and restart the Gateway. The Control UI and `openclaw update` cannot update this installation. No package changes or Gateway restart were attempted.",
      restartUnhealthy: "The replacement process never became healthy. The previous process stayed up so you can recover.",
      restartRevisionMismatch: "The restarted Gateway is running a different revision. Check the service install root and retry.",
      restartRevisionUnavailable: "The restarted Gateway could not report its revision. Check the service install root and logs before retrying.",
      alreadyCurrent: "This checkout is already at its tracked upstream revision.",
      managedServiceHandoffAlreadyRunning: "Another managed update is already running. Wait for it to complete, then refresh update status.",
      managedServiceHandoffUnavailable: "Stop the foreground Gateway, run `openclaw update`, then launch it again. For automatic updates, install a managed Gateway service.",
      doctorFailed: "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
      managedServiceHandoffFailed: "The update helper stopped before finishing. Run `openclaw update` in the terminal to see why.",
      managedServiceHandoffSpawnFailed: "The Gateway could not start the update helper. Run `openclaw update` in the terminal instead.",
      managedServiceHandoffParentTimeout: "The Gateway stayed up too long for the update helper. Start the update again, or run `openclaw update`.",
      default: "See the gateway logs for the exact failure and retry once the cause is fixed."
    },
    failedAtStep: "The update failed at {step}: {cause}.",
    succeededVersion: "Gateway updated to v{version}.",
    succeededCommit: "Gateway updated \xB7 now on {sha}.",
    succeeded: "Gateway updated and restarted."
  },
  devices: {
    readOnly: {},
    // The trigger and load failure stay eager; dialog copy follows its lazy renderer.
    pairing: {
      button: "Pair device",
      adminRequired: "Administrator access is required to create setup codes.",
      title: "Pair a device",
      loadFailed: "Could not load the pairing dialog. Check your connection and try again."
    },
    binding: {},
    inventory: {},
    // Lazy: en-devices.ts registers this subtree when the Devices page renders chips.
    capabilities: {},
    execApprovals: {}
  },
  worktrees: {
    adminRequired: "Browsing only. Worktree changes require operator.admin access.",
    newWorktree: "New worktree",
    ownerManual: "Manual",
    ownerSession: "Session",
    ownerWorkboard: "Workboard",
    title: "Managed Worktrees",
    subtitle: "Isolated repository checkouts owned by OpenClaw.",
    cleanNow: "Clean up now",
    name: "Name",
    namePlaceholder: "auto",
    baseBranch: "Base branch",
    baseBranchPlaceholder: "Remote default",
    repo: "Repository",
    empty: "No managed worktrees.",
    restorable: "Restorable",
    restore: "Restore",
    confirmDelete: "Snapshot and delete {name}?",
    confirmForceDelete: `Snapshot failed: {error}

Delete without a snapshot?`
  },
  agentChip: Oo,
  agentScope: No,
  newSession: {
    title: "New session",
    hint: "Pick where this session works, then say what to do.",
    placementReloadBlocked: "Recovery needs a reload. Unsaved starts will be lost.",
    discardUnsavedAndReload: "Discard unsaved starts and reload"
  },
  dashboardsPage: {
    emptyTitle: "No dashboards yet",
    emptyDescription: "Dashboards created in your tasks will appear here.",
    loadError: "Could not load dashboards: {error}",
    openFocusMode: "Open dashboard in focus mode",
    live: "Live",
    byAuthor: "By {author}",
    updated: "Updated {time}",
    updatedUnknown: "Update time unknown",
    totalLabel: "dashboards",
    searchLabel: "Search dashboards",
    searchPlaceholder: "Search dashboards\u2026",
    authorFilter: "Author",
    allAuthors: "All authors",
    sortLabel: "Sort",
    sortUpdated: "Recently updated",
    sortTitle: "Title A\u2013Z",
    resultCount: "Dashboards: {count}",
    noResultsTitle: "No matching dashboards",
    noResultsDescription: "Try another search or author."
  },
  dashboardDocument: {
    close: "Close dashboard",
    missingSession: "No dashboard session was specified.",
    notFound: "This session could not be found.",
    unavailable: "Session dashboards are unavailable for this connection.",
    loadFailed: "Could not load this dashboard: {error}. Check the Gateway connection and try again."
  },
  sessionsView: {
    advanced: "Advanced",
    copyDetails: "Copy details",
    copyLink: "Copy link",
    communication: {
      title: "Cross-session messaging",
      send: "Send messages",
      receive: "Receive messages",
      always: "Always",
      ask: "Ask",
      never: "Never",
      default: "default",
      sendDescription: "Allow this session to initiate messages to other sessions. Ask requires human approval; Never blocks them.",
      receiveDescription: "Allow other sessions to initiate messages to this session. Ask requires human approval; Never blocks them.",
      resetDescription: "Use the configured defaults for sending and receiving messages."
    },
    subagentPrefix: "Subagent:",
    automationPrefix: "Automation:",
    actionRequiresConnection: "Connect to the Gateway to change sessions.",
    actionUnavailable: "This Gateway does not support this session action.",
    actionRequiresScope: "This action requires {scope} access.",
    actionRequiresOwnership: "Only the session creator or an admin can make this change.",
    deletePreservedReasons: {
      "owner-mismatch": "owned elsewhere",
      busy: "live run or cleanup active",
      "foreign-lock": "foreign Git lock",
      "snapshot-failed": "OpenClaw could not create a safety snapshot",
      "cleanup-failed": "cleanup failed"
    },
    draftCleanupFailed: "Session deleted; browser draft remains. Clear site data.",
    title: "Sessions",
    subtitle: "Browse sessions and manage per-session overrides.",
    store: "Store: {path}",
    active: "Updated within",
    limit: "Limit",
    createdBy: "Created by {name}",
    ownedBy: "Owned by {name}",
    archivedBy: "Archived by {name}",
    archiveReason: "Archive reason",
    archiveReasonManual: "Archived manually",
    archiveReasonAgeRetention: "Automatically archived by age retention",
    archiveReasonActiveSessionCap: "Automatically archived because the active-session limit was reached",
    archiveReasonStaleDashboard: "Automatically archived after dashboard inactivity",
    archiveReasonRestartRecovery: "Archived when a replacement session was recovered",
    viewingNow: "viewing now",
    owners: "Owners",
    allOwners: "All owners",
    involvingMe: "Involving me",
    hideFromInvolvingMe: "Hide from Involving me",
    showInInvolvingMe: "Show in Involving me",
    specificOwner: "Specific owner",
    specificOwnerAvailable: "Specific owner: {count} available",
    specificOwnerSelected: "Specific owner: {name}",
    ownerYou: "{name} (You)",
    withParticipant: "with {name}",
    withMoreParticipants: "+{count} more",
    assignToMe: "Me",
    assignTo: "Assign to\u2026",
    filterControls: "Session filters",
    filters: "Filters",
    sourceFilters: "Session source filters",
    global: "Global",
    unknown: "Unknown",
    sessionState: "Session state",
    all: "All",
    snooze: "Snooze",
    wakeSession: "Wake session",
    snoozeChooseTime: "Choose another time",
    snoozeCustom: "Custom",
    snoozeDateTime: "Date and time",
    snoozeLocalTime: "Your local time ({zone})",
    snoozeFutureRequired: "Choose a date and time in the future.",
    snoozeHour: "In 1 hour",
    snoozeThreeHours: "In 3 hours",
    snoozeEvening: "This evening",
    snoozeTomorrow: "Tomorrow",
    snoozeNextWeek: "Next week",
    snoozed: "Snoozed",
    snoozeWakes: "Wakes {time}",
    snoozeTomorrowTime: "tomorrow {time}",
    sessionArchived: "Session archived",
    archiving: "Archiving\u2026",
    deleteAllArchived: "Delete all archived\u2026",
    deleteAllArchivedConfirm: "Delete {count} archived sessions and their transcripts? Any attached workers will be stopped safely first.",
    activeTooltip: "Loads sessions updated in the last {count} minutes.",
    limitTooltip: "Max sessions to load.",
    globalTooltip: "Include global sessions.",
    unknownTooltip: "Include unknown sessions.",
    archivedOnlyTooltip: "Show only archived sessions.",
    minutesPlaceholder: "min",
    searchPlaceholder: "Filter by key, agent, label, kind\u2026",
    clearSearch: "Clear search",
    user: "User",
    assistant: "Assistant",
    selected: "{count} selected",
    deleteSelected: "Delete",
    selectAllOnPage: "Select all on page",
    selectSession: "Select session",
    optionalPlaceholder: "(optional)",
    session: "Session",
    agent: "Agent",
    key: "Key",
    label: "Label",
    kind: "Kind",
    updated: "Updated",
    tokens: "Tokens",
    goal: "Goal",
    goalNote: "Goal note",
    thinking: "Thinking",
    fast: "Fast",
    verbose: "Verbose",
    reasoning: "Reasoning",
    actions: "Actions",
    addToWorkboard: "Add to Workboard",
    openWorkboardCard: "Open Workboard card",
    opensAsDashboard: "Opens as dashboard",
    approvalNeeded: "Approval needed",
    messageNeedsAttention: "{count} message needs attention",
    messagesNeedAttention: "{count} messages need attention",
    unsentDraft: "Unsent draft",
    noSessions: "No sessions found.",
    noActiveSessions: "No active sessions.",
    noArchivedSessions: "No archived sessions.",
    noSessionsMatchFilters: "No sessions match your filters.",
    pagination: "{start}-{end} of {total} rows",
    pageSize: "Rows per page",
    rowsPerPage: "{count} per page",
    showAll: "Show all",
    inherit: "inherit",
    offExplicit: "off (explicit)",
    auto: "auto",
    on: "on",
    off: "off",
    full: "full",
    stream: "stream",
    contextUsage: "{percent}% of context used ({used} / {context} tokens)",
    promptBudgetUsage: "{percent}% of last-run prompt budget used ({used} / {context} tokens)",
    promptBudgetUsageApprox: "Approximately {percent}% of last-run prompt budget used ({used} / {context} tokens)",
    contextUsageApprox: "~{percent}% of context used ({used} / {context} tokens, approximate)",
    showSessionDetails: "Show session details for {count}",
    hideSessionDetails: "Hide session details for {count}",
    sessionDetails: "Session details",
    overrides: "Overrides",
    status: "Status",
    statusLive: "Live",
    statusIdle: "Idle",
    statusUnknown: "Unknown",
    statusQueued: "Queued",
    statusRunning: "Running",
    statusDone: "Done",
    statusFailed: "Failed",
    statusInterrupted: "Interrupted",
    statusKilled: "Killed",
    statusTimeout: "Timed out",
    waitingForAnswer: "Waiting for your answer",
    waitingForApproval: "Waiting for approval",
    questionsNeedAnswer: "{count} questions need your answer",
    approvalsNeedApproval: "{count} requests need approval",
    attentionMore: "+{count} more",
    runFailedReason: "Run failed: {reason}",
    childRunFailedReason: "Child session {label} failed: {reason}",
    runErrorTimedOut: "Timed out",
    runErrorUnknown: "Unknown error",
    attentionRequired: "Session needs attention",
    openSession: "Open session",
    openFailed: "Could not open this session. Try again.",
    model: "Model",
    provider: "Provider",
    runtime: "Runtime",
    runDuration: "Run duration",
    lastActive: "Last active {time}",
    surface: "Surface",
    subject: "Subject",
    room: "Room",
    space: "Space",
    sessionId: "Session ID",
    activeRun: "Active run",
    subagentsWorking: "Subagents working",
    showChildSessions: "Show {count} child sessions for {session}",
    hideChildSessions: "Hide {count} child sessions for {session}",
    childSessions: "Child sessions",
    showMoreChildren: "Show {count} more",
    archived: "Archived",
    pinned: "Pinned",
    unread: "Unread",
    automationAttached: "Automation attached",
    incognito: "Incognito session",
    incognitoLabel: "Incognito",
    incognitoDescription: "Incognito session. History expires 24 hours after creation or when the Gateway restarts, whichever comes first.",
    incognitoLimits: "Your model provider still processes messages. Tools, plugins, and uploads may save data.",
    cloudWorkerPlacement: "Placement: {state}",
    placementWorkspaceConflict: "{placement} \xB7 1 workspace conflict",
    placementWorkspaceConflicts: "{placement} \xB7 {count} workspace conflicts",
    cloudWorkerDiskWarning: "Cloud session disk space is low",
    cloudWorkerDiskCritical: "Cloud session disk space is critically low",
    cloudWorkerDescendantConflict: "Cloud worker child: 1 workspace conflict",
    cloudWorkerDescendantConflicts: "Cloud worker children: {count} workspace conflicts",
    renameSession: "Rename session",
    renameSessionMenu: "Rename\u2026",
    setIconMenu: "Set icon",
    setColorMenu: "Color",
    setIconColorMenu: "Icon & color",
    sessionColor: "Session color: {color}",
    colors: {
      red: "Red",
      blue: "Blue",
      green: "Green",
      yellow: "Yellow",
      purple: "Purple",
      orange: "Orange",
      pink: "Pink",
      cyan: "Cyan"
    },
    iconEmojiSection: "Emoji",
    iconGlyphSection: "Icons",
    noIcon: "No icon",
    noColor: "No color",
    customEmojiCell: "Custom emoji\u2026",
    customEmojiTitle: "Custom emoji",
    customEmojiSet: "Set",
    customEmojiHint: "Any emoji works. Press {shortcut} for the system emoji picker.",
    customEmojiHintNoShortcut: "Any emoji works.",
    customIconCell: "Custom icon\u2026",
    customIconTitle: "Custom icon",
    customIconHint: "Paste an emoji or SVG. Press {shortcut} for the system emoji picker.",
    customIconHintNoShortcut: "Paste an emoji or SVG.",
    removeIcon: "Remove icon",
    pinSession: "Pin session",
    pinRootSessionsOnly: "Only root sessions can be pinned; pin the parent session instead.",
    unpinSession: "Unpin session",
    markUnread: "Mark as unread",
    markRead: "Mark as read",
    markUnreadCount: "Mark {count} as unread",
    markReadCount: "Mark {count} as read",
    forkSession: "Fork conversation",
    forkFromLastCompleted: "Fork from last completed message",
    forkedSession: "Forked session",
    copySessionId: "Session ID",
    copySessionLink: "Session link",
    copySessionPreviewLink: "Preview link",
    copyMarkdown: "Conversation as Markdown",
    openNewTab: "New tab",
    openNewWindow: "New window",
    splitBelow: "Split below",
    workspaceEditors: "Workspace \xB7 editor",
    resetAppearance: "Reset to default",
    copyTranscriptChanged: "Conversation changed while copying. Try again.",
    openWindowBlocked: "Allow pop-ups for this site, then try again.",
    splitUnavailable: "Open a conversation on a wide screen to use split view.",
    openPullRequest: "Open PR",
    openInEditorMenu: "Open in",
    archiveSession: "Archive session",
    archiveSessionCount: "Archive {count}",
    restoreSession: "Restore session",
    restoreSessionCount: "Restore {count}",
    moveSession: "Move session\u2026",
    moveSessionTitle: "Move session",
    moveSessionDescription: 'Choose where "{session}" should continue.',
    moveSessionNoReplayWarning: "OpenClaw safely reconciles the current workspace before moving. Active work is never replayed.",
    moveSessionActiveRunWarning: "The active turn will be interrupted. Partial output is not replayed; send the next turn again after the move.",
    moveSessionAction: "Move session",
    moveSessionCatalogFailed: "Could not load available destinations.",
    moveSessionFailed: "Move failed",
    moveSessionGatewayTarget: "Gateway",
    movingSession: "Moving to {target}\u2026",
    movingSessionGeneric: "Moving session\u2026",
    stopCloudWorker: "Stop cloud worker\u2026",
    initialTurnPausedByWorkerStop: "Worker stop requested. Review the initial message before retrying.",
    deleteSessionMenu: "Delete\u2026",
    deleteSessionCount: "Delete {count}\u2026",
    deleteSessionStale: 'Gateway connection replaced before "{session}" was deleted. Try again.',
    deleteSessionsStale: "Gateway connection replaced before {count} sessions were deleted. Try again.",
    groupBy: "Group by",
    groupByNone: "None",
    groupByCategory: "Custom groups",
    groupByPerson: "Person",
    showSessionPreview: "Show message preview",
    hideEmptyGroups: "Hide empty groups",
    hideEmptyGroupsSelected: "Hide empty groups: {mode}",
    emptyGroupsWhenFiltering: "When filtering",
    emptyGroupsAlways: "Always",
    emptyGroupsNever: "Never",
    showCronSessions: "Show automation sessions",
    showSystemSessions: "Show system sessions",
    groupByChannel: "Channel",
    groupByKind: "Kind",
    groupByAgent: "Agent",
    groupByDate: "Date",
    group: "Group",
    ungrouped: "Ungrouped",
    newGroup: "New group",
    newGroupPrompt: "New group name",
    newGroupTitle: "New group",
    newGroupCreate: "Create group",
    newGroupFailed: "Could not create the group.",
    newGroupStale: "Gateway connection replaced before the group was saved. Try again.",
    moveToGroup: "Move session to a group",
    moveToGroupMenu: "Move to group",
    moveToGroupMenuCount: "Move {count} to group",
    removeFromGroup: "Remove from group",
    moveBackToGroups: "Move back to Groups",
    groupMenu: "Group options for {group}",
    newSessionInGroup: "New session in {group}",
    groupDefaultsMenu: "New session defaults",
    groupDefaultsFailed: "Could not save the group defaults.",
    groupDefaultsStale: "Gateway connection replaced before the defaults were saved. Try again.",
    renameGroupMenu: "Rename group",
    renameGroupTitle: 'Rename group "{group}"',
    groupNameLabel: "Group name",
    deleteGroupMenu: "Delete group",
    deleteGroupTitle: 'Delete group "{group}"',
    deleteGroupConfirm: "The group is removed. Its sessions move back to the session list.",
    deleteGroupStale: 'Gateway connection replaced before "{group}" was deleted. Try again.',
    dragSessionHint: "Drag session to move between groups",
    dateToday: "Today",
    dateYesterday: "Yesterday",
    dateThisWeek: "This week",
    dateOlder: "Older",
    dateNoActivity: "No activity",
    groupRowCount: "{count} sessions",
    groupRowCountOne: "{count} session"
  },
  agents: {
    noAgents: "No agents",
    createdBy: "Created by {id}",
    defaults: {
      title: "Agent defaults",
      description: "Defaults every agent inherits unless overridden."
    },
    copyId: "Copy ID",
    default: "Default",
    setDefault: "Set Default",
    ...Uo,
    selectTitle: "Select an agent",
    selectSubtitle: "Pick an agent to inspect its workspace and tools.",
    tabs: {
      overview: "Overview",
      files: "Files",
      tools: "Tools",
      skills: "Skills",
      channels: "Channels",
      cronJobs: "Automations",
      memory: "Memory"
    },
    context: {
      title: "Agent Context",
      workspace: "Workspace",
      openFilesTab: "Open Files tab",
      primaryModel: "Primary Model",
      runtime: "Runtime",
      thinkingDefault: "Thinking Default",
      identityName: "Identity Name",
      identityAvatar: "Identity Avatar",
      skillsFilter: "Skills Filter",
      default: "Default",
      configurationSubtitle: "Workspace, identity, and model configuration.",
      schedulingSubtitle: "Workspace and scheduling targets."
    },
    identity: Fo,
    overview: {
      title: "Overview",
      subtitle: "Workspace paths and identity metadata.",
      selectedSkills: "{count} selected",
      allSkills: "all skills",
      unsavedConfig: "You have unsaved config changes.",
      modelSelection: "Model Selection",
      primaryModel: "Primary model",
      primaryModelDefault: "Primary model (default)",
      notSet: "Not set",
      inheritDefault: "Inherit default",
      inheritDefaultModel: "Inherit default ({model})",
      fallbacks: "Fallbacks",
      addFallback: "Add fallback\u2026"
    },
    toolCatalog: {
      groups: {
        files: "Files",
        runtime: "Runtime",
        web: "Web",
        memory: "Memory",
        sessions: "Sessions",
        ui: "UI",
        messaging: "Messaging",
        automation: "Automation",
        nodes: "Nodes",
        agents: "Agents",
        media: "Media"
      },
      descriptions: {
        read: "Read file contents",
        write: "Create or overwrite files",
        edit: "Make precise edits",
        applyPatch: "Patch files (OpenAI)",
        exec: "Run shell commands",
        process: "Manage background processes",
        webSearch: "Search the web",
        webFetch: "Fetch web content",
        memorySearch: "Semantic search",
        memoryGet: "Read memory files",
        sessionsList: "List sessions",
        sessionsHistory: "Session history",
        sessionsSend: "Send to session",
        sessionsSpawn: "Spawn sub-agent",
        sessionStatus: "Session status",
        browser: "Control web browser",
        canvas: "Control canvases",
        message: "Send messages",
        cron: "Schedule tasks",
        gateway: "Gateway control",
        nodes: "Nodes + devices",
        agentsList: "List agents",
        image: "Image understanding"
      },
      profiles: {
        minimal: "Minimal",
        coding: "Coding",
        messaging: "Messaging",
        full: "Full"
      }
    },
    skillsPanel: {
      title: "Skills",
      subtitle: "Per-agent skill allowlist and workspace skills.",
      loadConfig: "Load the gateway config to set per-agent skills.",
      customAllowlist: "This agent uses a custom skill allowlist.",
      inheritedAllowlist: "This agent inherits the default skill allowlist.",
      allEnabled: "All skills are enabled. Disabling any skill will create a per-agent allowlist.",
      loadAgent: "Load skills for this agent to view workspace-specific entries.",
      filter: "Filter",
      searchPlaceholder: "Search skills",
      shown: "{count} shown",
      empty: "No skills found.",
      missing: "Missing: {items}",
      reason: "Reason: {items}",
      learnedAlwaysOn: "Learned skill \u2014 archive in Workshop to hide",
      updateError: "Could not update the agent skill allowlist."
    },
    channels: {
      title: "Channels",
      subtitle: "Gateway-wide channel status snapshot.",
      lastRefresh: "Last refresh: {time}",
      loadHint: "Load channels to see live status.",
      empty: "No channels found.",
      connectedCount: "{connected}/{total} connected",
      noAccounts: "no accounts",
      configuredCount: "{count} configured",
      notConfigured: "not configured",
      enabledCount: "{count} enabled",
      setupGuide: "Setup guide"
    },
    cronPanel: {
      schedulerTitle: "Scheduler",
      schedulerSubtitle: "Gateway automations status.",
      jobs: "Jobs",
      nextWake: "Next wake",
      agentJobsTitle: "Agent Automations",
      agentJobsSubtitle: "Scheduled jobs targeting this agent.",
      noJobs: "No jobs assigned.",
      runNow: "Run Now",
      edit: "Edit",
      editJob: "Edit {name}"
    },
    files: {
      emptyDraft: "Empty draft",
      minRead: "{count} min read",
      markdownPreview: "Markdown Preview",
      extensionPreview: "{ext} Preview",
      preview: "Preview",
      expandPreview: "Expand preview",
      collapsePreview: "Collapse preview",
      editFile: "Edit file",
      closePreview: "Close preview",
      coreFilesTitle: "Core Files",
      coreFilesSubtitle: "Bootstrap persona, identity, and tool guidance.",
      workspace: "Workspace",
      loadHint: "Load the agent workspace files to edit core instructions.",
      empty: "No files found.",
      missing: "missing",
      selectFile: "Select a file to edit.",
      willCreateOnSave: "Will Create on Save",
      liveDraftPreview: "Live Draft Preview",
      savedPreview: "Saved Preview",
      updated: "Updated {time}",
      notCreatedYet: "Not Created Yet",
      updatedUnknown: "Updated Unknown",
      missingHint: "This file is missing. Saving will create it in the agent workspace.",
      addFile: "Add file\u2026",
      createHint: "This file does not exist yet. Saving will create it in the agent workspace.",
      content: "Content",
      words: "{count} words",
      lines: "lines",
      overwrite: "Overwrite",
      conflictHint: "This file changed in the agent workspace after this draft was started. Reload to take the workspace version, or Overwrite to replace it with this draft."
    }
  },
  debug: {
    lanes: {
      lane: "Lane",
      active: "Active",
      queued: "Queued",
      blocked: "Blocked"
    },
    overlay: {
      title: "System busyness",
      eyebrow: "Live diagnostics",
      move: "Move system busyness with arrow keys, or drag",
      minimize: "Minimize system busyness",
      expand: "Expand system busyness",
      lanes: "Lanes",
      status: "Event loop / status",
      activeRuns: "Active runs",
      events: "Events",
      cpu: "CPU",
      memory: "Memory",
      delayP99: "Delay p99"
    }
  },
  configForm: {
    redactedPlaceholder: "[redacted - click reveal to view]",
    sectionHelp: "Help for {section}",
    advancedDivider: "Advanced",
    advancedSettings: "Advanced settings",
    hideValue: "Hide value",
    revealValue: "Reveal value",
    disableStreamToReveal: "Disable stream mode to reveal value",
    storedSecretNotRevealable: "This editor cannot reveal the stored value.",
    unsupportedType: "Unsupported type: {type}. Use Raw mode.",
    structuredSecretRaw: "Structured value (SecretRef) - use Raw mode to edit",
    structuredSecretFile: "Structured value (SecretRef) - edit the config file directly",
    defaultValue: "Default: {value}",
    select: "Select...",
    enumOn: "On",
    enumOff: "Off",
    enumAuto: "Auto",
    nullValue: "null",
    jsonValue: "JSON value",
    invalidJson: "Enter valid JSON before leaving this field.",
    invalidString: "Enter a value that matches this setting's constraints.",
    invalidNumber: "Enter a value within the allowed range and step.",
    draftRejected: "This setting could not be saved. Your draft is still here.",
    unsupportedArray: "Unsupported array schema. Use Raw mode.",
    itemCountOne: "{count} item",
    itemCount: "{count} items",
    add: "Add",
    noItems: 'No items yet. Click "Add" to create one.',
    removeItem: "Remove item",
    customEntries: "Custom entries",
    addEntry: "Add Entry",
    key: "Key",
    removeEntry: "Remove entry",
    renameRedactedBlocked: "This entry holds a stored secret. Add the new key with its value, then remove this one.",
    schemaUnavailable: "Schema unavailable.",
    unsupportedSchema: "Unsupported schema. Use Raw.",
    unsupportedNode: "Unsupported schema node. Use Raw mode.",
    noSettingsMatch: 'No settings match "{query}"',
    noSettingsInSection: "No settings in this section",
    sections: {}
  },
  // Historical namespace from the pre-restructure "quick settings" page; its
  // keys now serve Models, Privacy & Security, Appearance, and Profile.
  // Renaming would force retranslation of every key, so the name stays.
  quickSettings: {
    language: "Language",
    model: {
      title: "Model & Thinking",
      model: "Model",
      thinking: "Thinking",
      fastMode: "Fast Mode",
      default: "Default",
      modelPolicy: "Model policy",
      thinkingLevels: {
        off: "Off",
        low: "Low",
        medium: "Medium",
        high: "High"
      },
      fastModes: {
        auto: "Auto",
        fast: "Fast",
        standard: "Standard",
        on: "On",
        off: "Off"
      }
    },
    channels: {
      title: "Channels",
      connect: "Connect \u2192"
    },
    appearance: {
      lobsterVisits: "Lobster visits",
      lobsterVisitsOn: "Drops by occasionally",
      lobsterVisitsThemeHidden: "The lobster stays home while the {theme} theme is active. Other visitors still drop by.",
      lobsterVisitsOff: "Never visits",
      lobsterSounds: "Lobster sounds",
      lobsterSoundsOn: "Tiny blubs when touched",
      lobsterSoundsOff: "Silent",
      lobsterdex: "Lobsterdex",
      lobsterdexSeen: "{seen}/{total} visited",
      lobsterdexFirstVisited: "{name} \xB7 first visited {date}",
      lobsterdexCardFirstVisited: "First visited {date}",
      lobsterdexCardShinySeen: "\u2726 Shiny spotted {date}",
      lobsterdexCardCopyLink: "Copy link",
      lobsterdexOpen: "Open Lobsterdex",
      lobsterdexThemeHidden: "This theme hides Lobsterdex. Your collection and preferences are preserved."
    },
    security: {
      intro: "Review gateway access, tool policy, device authentication, and approvals.",
      title: "Security",
      gatewayAuth: "Gateway auth",
      execPolicy: "Exec policy",
      browserEnabled: "Browser enabled",
      toolProfile: "Available tools",
      toolProfileDefault: "Using core and default plugin tools. Choose Full to include available optional plugin tools."
    },
    system: {
      gatewayHost: "Gateway Host",
      up: "Up {duration}",
      cpu: "CPU",
      memory: "Memory",
      disk: "Disk",
      usage: "{label} usage",
      loadAverage: "Load average: {values}",
      core: "{count} core",
      cores: "{count} cores",
      load: "load",
      used: "used",
      freeOf: "{free} free of {total}",
      runtime: "Node {version} \xB7 PID {pid}"
    },
    personal: {
      browserOnly: "Stored in this browser only."
    }
  },
  configPage: {},
  configView: {
    adminRequired: "Configuration changes require operator.admin access.",
    channelSettings: "Channel settings",
    categories: {},
    sections: {},
    themes: {},
    textSizes: {},
    profileSyncedHint: "Saved to your profile \u2014 follows you on every device.",
    syncedHint: "Synced across your devices through the gateway.",
    syncPendingHint: "Waiting to sync through the gateway.",
    notifications: {},
    appearance: {},
    chatPrefs: {},
    sidebarPrefs: {},
    sessionObserver: {},
    connection: {},
    root: "<root>",
    itemCount: "[{count} item]",
    itemCountPlural: "[{count} items]",
    form: "Form",
    raw: "Raw",
    formUnsafeTitle: "Form view can't safely edit some fields",
    rawTitle: "Edit raw JSON/JSON5 config",
    rawUnavailableTitle: "Raw mode unavailable for this snapshot",
    open: "Open",
    fileOpenedOnGateway: "Configuration file opened on Gateway host.",
    applying: "Applying\u2026",
    autoSaveSaving: "Saving\u2026",
    autoSaveSaved: "Saved",
    autoSavePaused: "Autosave paused after reconnect",
    saveNow: "Save",
    autoSaveFailed: "Save failed",
    autoSaveRejected: "Settings not applied",
    autoSaveRejectedHint: "Current settings are unchanged.",
    rejectionDetails: "Show reason",
    recoveryNotRestored: "Settings could not be restored. Your draft is kept. Check {path} before saving again.",
    recoveryUnknown: "Settings restoration could not be confirmed. Your draft is kept. Check {path} before saving again.",
    recoveryBackup: "Inspect the recovery backup at {path}.",
    recoveryReload: "Discard draft and reload",
    discardUnconfirmed: "The last save could not be confirmed. Your draft is kept. Reload configuration before discarding this setting.",
    writeGatewayChanged: "This unsettled change belongs to a different Gateway. Reconnect to that Gateway to retry, or discard the draft.",
    writeUnconfirmed: "The last configuration change could not be confirmed. Your draft is kept. Retry before changing other settings.",
    autoSaveConflict: "Settings changed elsewhere",
    retry: "Retry",
    applyChanges: "Apply changes",
    rawDiscard: "Discard",
    reloadBlocked: "Finish saving or discard pending config changes before reloading.",
    rawDraftBlocksApply: "Save or discard edits in the Raw editor before applying changes.",
    rawDraftPendingFormTitle: "Unsaved raw config edits \u2014 save or discard them before switching to Form.",
    rawDraftBlocksFormEdit: "Unsaved raw config edits could not be parsed; resolve them in the Raw editor before changing settings.",
    rawDraftUnverified: "Cannot verify the raw draft against the saved configuration; reload and retry.",
    invalidConfig: "Your configuration is invalid. Some settings may not work as expected.",
    dismissWarning: "Don't remind again",
    viewPendingChangesRaw: "View pending changes",
    rawDiffUnavailable: "Changes detected (JSON diff not available)",
    hideEnvValues: "Hide env values",
    revealEnvValues: "Reveal env values",
    peek: "Peek",
    loadingSchema: "Loading schema\u2026",
    formUnsafeCount: "1 setting in this config can only be edited as text: {paths}",
    formUnsafeCountPlural: "{count} settings in this config can only be edited as text: {paths}",
    formUnsafeMore: "+{count} more",
    openRawEditor: "Open Raw editor",
    rawConfig: "Raw config (JSON/JSON5)",
    secretCount: "{count} secret",
    secretCountPlural: "{count} secrets",
    redacted: "redacted",
    visible: "visible",
    revealSensitive: "Reveal sensitive values",
    hideSensitive: "Hide sensitive values",
    toggleRawRedaction: "Toggle raw config redaction",
    sensitiveHidden: "{count} sensitive value hidden. Use the reveal button above to edit the raw config.",
    sensitiveHiddenPlural: "{count} sensitive values hidden. Use the reveal button above to edit the raw config."
  },
  execApproval: {
    scope: {
      standingGrant: 'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
      standingGrantDays: 'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
      messageSend: "Sends to {count} recipient(s) via {target}",
      payment: "Pays {amount} {currency} to {target}",
      externalPost: "Posts externally to {target}"
    },
    expiresIn: "expires in {time}",
    expired: "expired",
    execApprovalNeeded: "Exec approval needed",
    pluginApprovalNeeded: "Plugin approval needed",
    requestedBySession: "Approval requested by session {session}",
    pending: "{count} pending",
    otherPending: "Other pending requests",
    reviewRequest: "Review approval from {agent}: {command}",
    decisionRequest: "{decision}: {command}",
    agentPendingOne: "{count} pending approval",
    agentPending: "{count} pending approvals",
    allowOnce: "Allow once",
    alwaysAllow: "Always allow",
    alwaysAllowHere: "Always allow here",
    allowAlwaysUnavailable: "Allow Always is unavailable for this command.",
    reviewOnly: "Review only. Sign in with approval access to record a decision.",
    deny: "Deny",
    details: "Details",
    labels: {
      host: "Host",
      session: "Session",
      cwd: "CWD",
      resolved: "Resolved",
      security: "Security",
      ask: "Ask"
    }
  },
  approvalPage: {
    brandName: "OpenClaw",
    eyebrow: "Operator approval",
    loadingTitle: "Loading approval",
    loadingDescription: "Checking the current approval state with the Gateway.",
    unavailableTitle: "Approval unavailable",
    unavailableDescription: "This approval could not be found or this device is not authorized to review it.",
    connectionErrorTitle: "Connection interrupted",
    connectionErrorDescription: "OpenClaw cannot confirm or record a decision while disconnected. Reconnect to check the current status.",
    retry: "Retry",
    execTitle: "Command approval",
    pending: "Waiting for your decision",
    pendingDescription: "Review the request carefully. The first answer from any surface wins.",
    approvedHere: "Approved here",
    deniedHere: "Denied here",
    resolvedElsewhere: "Resolved elsewhere",
    resolvedElsewhereDescription: "Another surface or an earlier attempt recorded the decision first.",
    approved: "Approved",
    denied: "Denied",
    expired: "Expired",
    cancelled: "Cancelled",
    allowedOnceDescription: "The operation was approved for this request only.",
    allowedAlwaysDescription: "The operation was approved with the always-allow decision.",
    deniedDescription: "The operation was denied and will not continue.",
    expiredDescription: "No decision arrived before the deadline, so the operation was denied.",
    cancelledDescription: "The requesting run ended before a decision could be used.",
    summaryLabel: "Summary",
    commandLabel: "Command",
    requestLabel: "Request details",
    nodeLabel: "Node",
    expiresLabel: "Expires",
    resolvedLabel: "Resolved",
    actionsLabel: "Approval decisions",
    resolvingDecision: "Recording {decision}\u2026",
    safeToClose: "The decision is recorded. You can close this page.",
    openControlUi: "Open Control UI"
  },
  agentTools: {},
  skillGroups: {
    workspace: "Workspace Skills",
    learned: "Learned Skills",
    builtIn: "Built-in Skills",
    installed: "Installed Skills",
    extra: "Extra Skills",
    other: "Other Skills"
  },
  skillsPage: {},
  skillStatus: {
    bundled: "bundled",
    eligible: "eligible",
    blocked: "blocked",
    disabled: "disabled",
    blockedAllowlist: "blocked by allowlist",
    blockedAgentFilter: "blocked by agent filter"
  },
  nav: {
    gateway: {
      sectionLabel: "Gateway",
      menuLabel: "Gateway: {gateway}",
      primaryTag: "primary",
      setPrimary: "Set as primary\u2026",
      openSettings: "Gateway settings\u2026",
      connected: "Connected",
      unreachable: "Unreachable",
      unknown: "Unknown status"
    },
    owner: "Owner",
    back: "Back",
    forward: "Forward",
    settings: "Settings",
    askOpenClaw: "Ask OpenClaw",
    askBrand: "Ask {brand}",
    settingsGroupDevice: "This Mac",
    settingsGroupThisComputer: "This computer",
    settingsGroupThisIPhone: "This iPhone",
    settingsGroupThisIPad: "This iPad",
    settingsGroupThisDevice: "This device",
    settingsGroupConnections: "Connections",
    settingsGroupAgents: "Agents & Tools",
    settingsGroupSecurity: "Privacy & Security",
    settingsGroupSystem: "System",
    settingsSearchLabel: "Search settings",
    settingsSearchPlaceholder: "Search settings\u2026",
    settingsSearchNoResults: "No matching settings.",
    settingsSearchClear: "Clear settings search",
    settingsLoadFailed: "Settings navigation could not load.",
    exitSettings: "Back to app",
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
    resize: "Resize sidebar",
    more: "More",
    home: "Home",
    pages: "Pages",
    pin: "Pin",
    unpin: "Unpin",
    customize: "Edit pinned items",
    customizeReset: "Reset pinned items",
    workboardGroup: "WorkBoard"
  },
  terminal: {
    title: "Terminal",
    copiedToClipboard: "Copied to clipboard",
    toggle: "Toggle terminal",
    open: "Open terminal",
    openWindow: "Open terminal in new window",
    hide: "Hide terminal",
    resize: "Resize terminal panel",
    newSession: "New terminal session",
    addFiles: "Add files to terminal",
    dropFiles: "Drop files to add them",
    uploadProgress: "Uploading {current} of {total}",
    uploadFailed: "Upload failed",
    retryUpload: "Retry",
    insertUploadedPaths: "Insert uploaded paths",
    uploadExpired: "Uploaded files may have expired. Cancel this batch and choose the files again.",
    closeSession: "Close terminal session",
    sessions: "Terminal sessions",
    refreshSessions: "Refresh",
    loadingSessions: "Loading sessions\u2026",
    noSessions: "No live terminal sessions",
    currentSession: "current",
    sessionAttached: "attached",
    attachSession: "Attach session",
    attachFailed: "Could not attach terminal session",
    startCancelled: "Terminal start was cancelled. Try again.",
    connecting: "Connecting to session\u2026",
    connectionTimedOut: "Session did not connect within 30 seconds.",
    refreshRequired: "Control UI updated. Reload this page to continue the terminal action.",
    tabLabel: "shell {n}",
    tabHint: "{agent} \xB7 {cwd}",
    agentOwnedBadge: "agent",
    exited: "exited",
    exitedCode: "exited ({code})",
    exitedSignal: "exited (signal {signal})",
    detached: "detached",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    dockMain: "Fill main content area",
    dockMode: "Terminal panel position",
    unavailable: "The terminal is not available on this gateway.",
    unusableSession: "The Gateway returned an unusable terminal session (missing {field}). The Gateway is likely older than this Control UI \u2014 update it, then retry.",
    uploadTooLarge: "File exceeds the 16 MiB terminal upload limit: {file}",
    uploadUnsafeCmdPath: "Cannot safely insert an uploaded path containing % or ! into cmd.exe",
    uploadUnsupportedShell: "Cannot safely insert an uploaded path into unsupported shell: {shell}",
    uploadInvalidNativePath: "Cannot safely insert the uploaded native file path"
  },
  browser: {
    nativeTab: "App tab",
    remoteTab: "Agent browser tab",
    stop: "Stop loading",
    profile: "Browser profile: {profile}",
    title: "Browser",
    open: "Open",
    openPanel: "Open browser panel",
    moreActions: "More actions",
    copyUrl: "Copy URL",
    openNewTab: "Open in new tab",
    openWithinOpenClaw: "Open in OpenClaw",
    toggle: "Toggle browser panel",
    close: "Close browser panel",
    resize: "Resize browser panel",
    newTab: "New tab",
    closeTab: "Close tab",
    untitledTab: "New tab",
    tweetPost: "Post on X",
    openPost: "Open post",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    openExternal: "Open in your browser",
    urlPlaceholder: "Enter a URL and press Enter",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    annotate: "Annotate page",
    inspect: "Inspect element",
    annotateSend: "Send to chat",
    annotateUndo: "Undo",
    annotateClear: "Clear",
    annotateDone: "Exit annotate mode",
    annotateHint: "Draw on the page, then send the markup to your chat.",
    inspectName: "Name",
    inspectRole: "Role",
    inspectFocusable: "Focusable",
    loading: "Loading page\u2026",
    notRunning: "The gateway browser is not running.",
    start: "Start browser",
    errors: {},
    annotatePrompt: {}
  },
  desktop: {
    title: "Desktop",
    openWindow: "Open desktop in new window",
    unavailable: "Desktop viewing is unavailable for this connection.",
    toggle: "Toggle desktop panel",
    reconnect: "Reconnect",
    connecting: "Connecting to desktop\u2026"
  },
  systems: {},
  routeTitles: {
    modelProviders: "Models",
    notifications: "Notifications",
    advanced: "Advanced"
  },
  tabs: {
    device: "This Mac",
    devicePermissions: "Permissions",
    agentsHome: "Agents",
    agents: "Agents",
    activity: "Activity",
    meetings: "Meetings",
    apps: "Apps",
    portals: "Portals",
    approvals: "Approvals",
    workboard: "Workboard",
    worktrees: "Worktrees",
    channels: "Channels",
    connection: "Gateway",
    sessions: "Sessions",
    systems: "Systems",
    usage: "Usage",
    cron: "Automations",
    skills: "Skills",
    plugins: "Plugins",
    skillWorkshop: "Skill workshop",
    devices: "Devices",
    claws: "Claws",
    cloudWorkers: "Cloud environments",
    chat: "Chat",
    dashboards: "Dashboards",
    custodian: "OpenClaw",
    profile: "Profile",
    communications: "Communications",
    appearance: "Appearance",
    lobsterdex: "Lobsterdex",
    automation: "Automation",
    mcp: "MCP",
    memory: "Memory",
    search: "Search",
    talk: "Talk",
    infrastructure: "Infrastructure",
    labs: "Labs",
    updates: "Updates",
    about: "About",
    aiAgents: "Agent Defaults",
    modelSetup: "Model Setup",
    memoryImport: "Import Memory",
    security: "Privacy & Security",
    secrets: "Secrets",
    debug: "Debug",
    logs: "Logs",
    plugin: "Plugin"
  },
  subtitles: {
    device: "App settings and capabilities on this Mac.",
    devicePermissions: "Manage macOS access, location, and computer presence.",
    agentsHome: "Who is on your team and what they are doing",
    agents: "Workspaces, tools, identities.",
    activity: "Recent sessions across people using this gateway.",
    meetings: "Meeting notes and transcripts across this gateway.",
    apps: "Companion apps for phone, watch, desktop, and browser.",
    portals: "Live previews from agent-run applications.",
    approvals: "Recent exec, plugin, and system-agent approvals.",
    workboard: "Agent work queue and session handoff.",
    worktrees: "Isolated agent task checkouts and recovery snapshots.",
    channels: "Channels and settings.",
    connection: "Gateway endpoint, credentials, and handshake status.",
    sessions: "Active sessions and defaults.",
    systems: "Machines and desktops.",
    usage: "API usage and costs.",
    cron: "Scheduled tasks and recurring agent runs.",
    skills: "Manage your agent skills",
    plugins: "Extend your Claw with tools",
    skillWorkshop: "Skills your agent learned, recent changes, and undo.",
    devices: "Paired devices, pairing approvals, and exec bindings.",
    claws: "Explore and add official Claws.",
    cloudWorkers: "Repository snapshots and machines for cloud sessions.",
    chat: "Gateway chat for quick interventions.",
    dashboards: "Tasks with saved dashboards.",
    custodian: "System setup and care.",
    config: "Legacy settings route; opens Appearance.",
    profile: "Your display name, avatar, and identity on this gateway.",
    communications: "Messages, text-to-speech, and meeting capture settings.",
    appearance: "Theme and UI settings.",
    lobsterdex: "Every lobster palette that has visited this browser.",
    automation: "Commands, hooks, automations, and plugins.",
    mcp: "MCP servers, auth, tools, and diagnostics.",
    memory: "Memory engine, search, and dreaming.",
    search: "Choose how agents search the web and check provider health.",
    talk: "Realtime voice: provider, model, and speaker voice.",
    infrastructure: "Gateway, browser, node host, discovery, and ACP settings.",
    labs: "Experimental agent and tool capabilities.",
    updates: "Release channel, automatic updates, and current update status.",
    about: "Control UI and connected Gateway build identity.",
    aiAgents: "Global agent defaults: skills, tools, and session.",
    modelSetup: "Connect a verified AI model",
    modelProviders: "Default models, behavior, provider access, usage, and cost.",
    memoryImport: "Bring Codex and Claude Code memory into an agent workspace.",
    notifications: "Browser push notifications from your gateway.",
    security: "Gateway auth, exec policy, tool profile, and approvals.",
    advanced: "Every remaining config section, plus the raw file editor.",
    debug: "Snapshots, events, RPC.",
    logs: "Live gateway logs.",
    plugin: "Plugin-provided panel."
  },
  meetingCapture: {
    title: "Meeting capture",
    description: "Choose which sources can save meeting notes on this Gateway.",
    sources: "Auto-start sources"
  },
  cloudWorkersPage: {},
  portalsPage: {},
  modelSetup: {
    discovery: {},
    missingAuth: "No provider credential is configured for this model. Set it up in Model Setup.",
    commandHint: "Try /models or /help.",
    heading: "Connect a verified AI model",
    intro: "OpenClaw discovers AI access on this Gateway. Choose a provider to begin; nothing is selected, tested, installed, or saved automatically.",
    required: {
      title: "No AI provider configured",
      body: "Connect a provider and choose a model to send messages.",
      action: "Connect an AI provider"
    },
    loading: "Checking this Gateway for available AI access\u2026",
    testing: "Testing \u2014 asking the selected model for a quick reply\u2026",
    retry: "Retry",
    checkAgain: "Check again",
    recovery: {
      unknown: "The previous activation is unresolved. Check again refreshes the current setup without repeating it. If a model is available, you can verify and use it.",
      wait: "The previous setup attempt may still be running. Check again can refresh its result. If no model appears, check again after {time} to choose a provider.",
      useCurrent: "Verify & use selected model"
    },
    verify: {},
    access: {
      adminRequired: "Model setup requires operator.admin access.",
      gatewayTooOld: "The Gateway is running an older OpenClaw version"
    },
    candidates: {
      title: "Found on this Gateway",
      recommended: "Recommended",
      credentialsReady: "Credentials ready",
      signInNeeded: "Sign-in needed",
      detected: "Detected",
      testAndUse: "Test & use",
      retry: "Retry test",
      testingButton: "Testing\u2026"
    },
    nativeDiscovery: {},
    nativeModels: {
      title: "Use an installed agent",
      body: "Choose a model from an installed agent. It keeps its own sign-in and tools. Use saves your choice without running the setup test.",
      choose: "Choose a model",
      use: "Use",
      saving: "Saving\u2026",
      loading: "Checking installed agents\u2026",
      empty: "No models are available from installed agents. Check the installed app, then open the picker again.",
      unconfirmed: "Availability not confirmed"
    },
    empty: {
      title: "Recommended installs",
      intro: "Install an assistant or local model service, then check again."
    },
    signIn: {
      title: "Set up and verify a model",
      description: "Setup requests a model reply. To save an account first, choose Connect provider.",
      verify: "Set up & verify",
      install: "Review & install",
      custom: "Set up endpoint",
      more: "More sign-in options"
    },
    prepare: {
      title: "Run a model locally",
      intro: "Use a local model service or prepare a private GGUF model on this Gateway.",
      ollamaButton: "Check & set up",
      ollamaLabel: "Ollama",
      ollamaHint: "Connect to the Ollama service on this Gateway and prepare a tools-capable model",
      llamaCppLabel: "llama.cpp",
      providerNotReady: "{provider} did not expose a usable local model. Review the setup result, then retry."
    },
    manual: {
      title: "Connect with an API key or token",
      provider: "Provider and access method",
      selectProvider: "Select a provider",
      selectProviderHint: "Choose where this credential comes from",
      accessValue: "API key or token",
      accessValueFor: "{provider} API key or token",
      accessValuePlaceholder: "Paste an API key or token",
      connectAndVerify: "Connect & verify",
      verifyHint: "OpenClaw verifies a real model reply before marking the connection ready.",
      required: "Choose a provider and enter an API key or token."
    },
    success: {},
    utility: {},
    failure: {
      auth: "Authentication failed",
      rateLimit: "Rate limited",
      billing: "Billing problem",
      timeout: "Timed out",
      format: "Invalid response",
      unavailable: "Unavailable",
      unknown: "Connection failed"
    },
    failureGuidance: {
      auth: "Review the provider credential or sign-in, then retry.",
      rateLimit: "Wait for the provider limit to reset, then retry.",
      billing: "Restore provider billing or quota, then retry.",
      timeout: "The model did not finish the setup test in time. Warm it or choose a faster model, then retry.",
      unavailable: "Make sure the provider service is running and reachable, then retry.",
      format: "Check that the endpoint exposes a compatible chat model, then retry.",
      unknown: "Review the connection details, then retry."
    },
    errors: {
      requestFailed: "Model setup request failed.",
      activationFailed: "The model could not be activated."
    },
    wizard: {
      dialogLabel: "Provider sign-in",
      prepareDialogLabel: "Local model setup",
      title: "Sign in with a provider",
      connected: "Account connected.",
      prepareTitle: "Set up a local model",
      starting: "Starting provider sign-in\u2026",
      prepareStarting: "Starting local model setup\u2026",
      checking: "Checking your model setup\u2026",
      working: "Working\u2026",
      continue: "Continue",
      submit: "Submit",
      openSignIn: "Open sign-in",
      copy: "Copy",
      copyCode: "Copy code",
      copyLink: "Copy link",
      manualEntry: "Use manual entry",
      browserInstructions: "Complete sign-in in your browser, then return here.",
      waiting: "Waiting for sign-in\u2026",
      deviceCodeWarning: "Continue only if you started this sign-in yourself. If a website or another person gave you this code, cancel.",
      expires: "Expires in {count} minutes",
      cancelled: "Provider sign-in was cancelled.",
      finishingStep: "Setup is finishing the current step. You can cancel when it finishes.",
      cancelFailed: "Could not confirm cancellation: {error}",
      sessionExpired: "The Gateway no longer has this setup session. It may already have finished. Close this dialog and choose Check again to review the current setup.",
      gatewayNotResponding: "The Gateway is not responding. Check that it is running, then try again.",
      gatewayReconnecting: "The Gateway is not responding. Waiting for it to reconnect.",
      notComplete: "Sign-in finished, but model setup is not complete yet."
    }
  },
  memoryImport: {},
  onboarding: {
    memoryImport: {
      title: "Bring your assistant memory with you",
      body: "OpenClaw found memory from other coding assistants. Import it into your agent workspace?",
      plannedCount: "{count} ready to import",
      alreadyImported: "Already imported: {count}",
      sourceUnavailable: "Source path unavailable",
      import: "Import",
      skip: "Skip",
      reviewDetails: "Review details",
      importingProvider: "Importing\u2026",
      providerResult: "Migrated {migrated}, skipped {skipped}",
      providerIncomplete: "Migrated {migrated}, skipped {skipped}, {errors} failed, {conflicts} conflicts",
      providerError: "Import failed: {error}",
      connectionChanged: "Skipped: the Gateway connection changed during the import",
      unknownError: "Request failed",
      doneTitle: "Memory import finished",
      doneBody: "Migrated {migrated}, skipped {skipped}. You can continue setting up OpenClaw."
    }
  },
  assistantPanel: {
    title: "Assistant sidebar",
    home: "Home",
    toggle: "Talk to your Home agent",
    openHome: "Open Home full page",
    close: "Close assistant sidebar",
    resize: "Resize assistant sidebar",
    dockBottom: "Dock assistant sidebar at bottom",
    dockRight: "Dock assistant sidebar at right",
    context: "Working on: {context}",
    contextOff: "Work context off",
    removeContext: "Remove work context",
    includeContext: "Include work context",
    selection: "Selected text",
    attachSelection: "Attach selected text",
    removeSelection: "Remove selected text"
  },
  custodian: {
    title: "OpenClaw",
    subtitleCaretaker: "System setup and care.",
    exitSetup: "Exit setup",
    newAgent: "New agent",
    hatchDraft: "Wake up, my friend!",
    placeholder: "Message OpenClaw\u2026",
    sensitivePlaceholder: "Enter sensitive value\u2026",
    sensitiveReply: "Sensitive reply sent",
    cancel: "Cancel",
    send: "Send",
    thinking: "OpenClaw is thinking",
    earlier: "Earlier",
    requestFailed: "OpenClaw could not reply. Try again.",
    connectionChanged: "The Gateway connection changed. Retry to continue this setup.",
    sessionRestarted: "{error} OpenClaw started a fresh session; earlier messages remain for context.",
    unsupportedGateway: "This Gateway does not offer openclaw.chat. Update the Gateway and reconnect to continue setup.",
    accessRequired: "Setup requires openclaw.chat with operator.admin access. Pair this browser with operator.admin scope, then reconnect.",
    autoSetup: {
      title: "AI setup",
      connecting: "Connecting your AI...",
      verifying: "Checking a real conversation. This may take a minute or more.",
      using: "Using {label} ({modelRef}) on {gateway}",
      sharedCodexLogin: "Using your existing Codex login \xB7 sessions shared with Codex",
      separateLogin: "Use a separate login",
      thisComputer: "This computer",
      thisGateway: "this Gateway",
      alternatives: "Or use another AI",
      signInTitle: "Connect ChatGPT to get started",
      signInBody: "OpenClaw is ready to connect your ChatGPT account.",
      signIn: "Sign in with ChatGPT",
      startingSignIn: "Opening ChatGPT sign-in...",
      unavailableTitle: "Your AI needs a little help",
      unavailableBody: "OpenClaw could not connect an AI automatically.",
      nativeSetup: "Open AI setup",
      commandHint: "To connect an AI, run",
      differentGateway: "Use a different Gateway",
      reviewPermissions: "Review permissions",
      failed: "OpenClaw could not finish AI setup. Try again.",
      safety: "OpenClaw can take actions using the permissions and services you enable. Review prompts and only connect tools you trust."
    },
    panel: {
      title: "OpenClaw",
      toggle: "Toggle Ask OpenClaw",
      close: "Close Ask OpenClaw",
      resize: "Resize Ask OpenClaw",
      dockBottom: "Dock Ask OpenClaw at bottom",
      dockRight: "Dock Ask OpenClaw at right"
    },
    history: {
      button: "History",
      title: "Recent changes",
      description: "What changed on this system, newest first.",
      loading: "Loading recent changes\u2026",
      empty: "No recorded changes yet.",
      requestFailed: "OpenClaw could not load change history.",
      loadMore: "Load more",
      loadingMore: "Loading more\u2026",
      changedPaths: "Changed paths ({count})",
      invalidEdit: "This manual edit did not pass configuration validation.",
      opaqueChange: "Formatting or comments changed without visible configuration path changes.",
      sources: {
        systemAgent: "system-agent",
        doctor: "doctor",
        settings: "settings",
        cli: "CLI",
        pluginInstall: "plugin install",
        manualEdit: "manual edit",
        unknown: "unknown"
      }
    },
    nudge: {
      configReload: "Configuration reload stopped \u2014 ask me what happened",
      channelAuth: "{channel} authentication degraded \u2014 ask me what happened",
      channelDisconnected: "{channel} just disconnected \u2014 ask me what happened",
      channelDegraded: "{channel} is degraded \u2014 ask me what happened",
      channelFallback: "A channel",
      dismiss: "Dismiss this update",
      channelSetupTitle: "Reach OpenClaw outside this app",
      channelSetupBody: "The web app already works. Add a channel only if you want to message OpenClaw from another service.",
      channelSetupAction: "Set up a channel",
      channelSetupDismiss: "Keep using the web app",
      channelStatusErrorTitle: "Channel status is unavailable",
      channelStatusErrorBody: "Retry the check, or keep using the web app without a channel."
    }
  },
  mcpServers: {},
  mcpPage: {},
  talkPage: {},
  memoryPage: {},
  sessionsPage: {
    hubTablistLabel: "Session sections"
  },
  pluginsPage: {
    installed: "Installed",
    official: "Official",
    install: "Install"
  },
  labsPage: {
    intro: "Labs contains experimental capabilities that may change, break, or disappear between releases.",
    sectionTitle: "Experimental features",
    sectionDescription: "Changes save without restarting the Gateway. Code Mode and Tool Search apply to future agent runs.",
    documentation: "Documentation",
    restartRequired: "Gateway restart required.",
    saveErrorTitle: "Could not update feature",
    saveFailed: "The feature setting could not be saved.",
    decisionAssistance: {},
    codeMode: {},
    swarm: {
      title: "Swarm",
      groupTitle: "Parallel tasks",
      defaultPhase: "Unphased",
      progress: "{complete} of {total}",
      active: "{running} running \xB7 {queued} queued \xB7 {failed} failed or stopped",
      finished: "{done} completed \xB7 {failed} failed or stopped",
      completed: "{done} completed",
      failedOrStopped: "Failed or stopped",
      childOutcome: "Child runs finished. Check the conversation for the final response.",
      childOutcomeProcessing: "Child runs finished. The parent is processing their results.",
      details: "Child details",
      detailsUnavailable: "Child details are unavailable. Counts include all accepted workers.",
      otherGroups: "{count} more active groups"
    },
    toolSearch: {},
    customPluginUi: {},
    hostDesktop: {},
    workerDesktop: {}
  },
  aboutPage: {
    productName: "OpenClaw",
    tagline: "Your personal AI assistant, running on your own devices.",
    waveHello: "Wave hello to Clawd",
    linksLabel: "Community and resources",
    linkWebsite: "Website",
    linkDocs: "Docs",
    linkGitHub: "GitHub",
    linkDiscord: "Discord",
    linkX: "X (Twitter)",
    linkChangelog: "Changelog",
    license: "\xA9 2026 OpenClaw Foundation \u2014 MIT License.",
    artifactTitle: "Control UI",
    artifactSubtitle: "Identity embedded when this browser artifact was built.",
    artifactDetails: "Control UI build details",
    version: "Version",
    commit: "Commit",
    branch: "Branch",
    built: "Built",
    unavailable: "Unavailable",
    copyCommit: "Copy full commit hash",
    copyingCommit: "Copying commit hash",
    copiedCommit: "Commit hash copied",
    copyCommitFailed: "Could not copy commit hash",
    gateway: "Gateway",
    gatewayVersion: "Connected Gateway version",
    gatewayVersionHint: "Reported by the active Gateway connection; separate from this Control UI build."
  },
  appsPage: {},
  presence: {
    sharedOwner: {
      name: "Shared owner",
      hint: "Connected with the Gateway token or over a tunnel, not a personal sign-in."
    },
    rosterTitle: "Online",
    usersTitle: "Users",
    allUsers: "All users",
    directoryFailed: "Could not load all users. Retry",
    filters: {
      label: "Filter & sort people",
      noMatches: "No people match this filter",
      presence: "Active people first",
      reset: "Reset to defaults",
      running: "Running sessions",
      total: "Total sessions",
      name: "Name"
    },
    active: "Active",
    onlineActive: "Online \xB7 Active",
    onlineIdle: "Online \xB7 Idle",
    idle: "Idle",
    offline: "Offline",
    sessions: {
      openCount: "{count}\xA0open",
      runningCount: "{count}\xA0running",
      openHint: "Owned, unarchived conversations you can access across agents. Excludes hidden subagents, automation, and system sessions.",
      runningHint: "Open sessions actively executing an agent turn. Queued work is not running.",
      counts: "{open} open sessions, {running} running",
      unavailable: "Session counts unavailable",
      retry: "Counts may be out of date. Retry"
    },
    card: {
      details: "Details for {name}",
      loadFailed: "Could not open details. Try again, or open this person\u2019s Activity page.",
      ariaLabel: "Activity for {name}",
      person: "Person",
      onlineFor: "Online for",
      where: "Where",
      reportedTimeZone: "Reported time zone: {zone}",
      lastActivity: "Last interaction",
      notObserved: "Activity unavailable",
      viewingNow: "Viewing now",
      recentSessions: "Recent sessions",
      noVisibleSessions: "No visible sessions being viewed.",
      noRecentSessions: "No recent visible sessions.",
      sessionUpdated: "Session updated",
      ago: "ago",
      viewActivity: "View activity",
      web: "Web app",
      cli: "Command line",
      terminal: "Terminal",
      app: "App"
    }
  },
  activityFeed: {
    partialHistory: "People and counts describe visible recorded session associations; retained history and this people list may be incomplete.",
    sessionsMode: "Sessions",
    searchPlaceholder: "Search session titles\u2026",
    time: "Time",
    time24h: "Last 24 hours",
    time7d: "Last 7 days",
    time30d: "Last 30 days",
    timeAll: "All time",
    everyone: "Everyone",
    peopleButtonLabel: "Filter sessions by person",
    lastActive: "\xB7 {time}",
    unresolvedIdentities: "Unresolved identities",
    clearPersonFilter: "Clear person filter",
    showing: "Showing {shown} of {total}",
    today: "Today",
    yesterday: "Yesterday",
    unknownDate: "Unknown date",
    noSessions: "No sessions match these filters.",
    automationGroup: "{count} automation sessions",
    automation: "Automation",
    inspectRun: "Inspect run",
    recap: "Session recap",
    recapMissing: "No recap yet",
    recapUpdating: "Updating recap\u2026",
    recapStale: "New activity since this recap",
    recapUnavailable: "Recap unavailable",
    recapRefreshFailed: "Couldn\u2019t refresh recap",
    recapRetry: "Retry recap",
    recapUpdated: "Recap updated {time}",
    backToSessions: "Back to sessions",
    channelLabel: "Channel: {value}",
    agentLabel: "Agent: {value}",
    online: "Online",
    idle: "Idle",
    offline: "Offline",
    unknownConnection: "Unknown client",
    connectionDetails: "Connection details \xB7 {count}",
    connectionOne: "1 connection",
    connectionMany: "{count} connections",
    lastInput: "Last input {time} ago",
    viewingNow: "Viewing now",
    notViewing: "Not viewing a session right now.",
    notFoundTitle: "Person not found",
    notFoundDescription: "No online presence or visible session association matches this identity."
  },
  githubPublication: {
    newAction: "Choose a new publication",
    capacity: 'Too many publications are awaiting review. Finish an existing publication, then select "{newAction}" to make room. Existing retries remain available.'
  },
  githubConnections: {
    title: "GitHub connections",
    mine: "My GitHub",
    system: "System GitHub",
    forMe: "For me",
    forSystem: "For the system"
  },
  profilePage: {
    personalInstructions: {
      title: "Personal instructions",
      description: "Tell this agent about you and how you like to work. This edits only your personal USER.md, not the shared workspace file."
    },
    offline: "Connect to the gateway to meet your agent.",
    access: {},
    usageStatistics: "Usage statistics",
    usageStatisticsDescription: "View activity, costs, and usage trends.",
    identity: {
      title: "Identity",
      menuLabel: "Identity menu",
      menuButtonLabel: "Identity and app menu for {name}",
      description: "Your profile on this gateway.",
      avatar: "Avatar",
      chooseAvatar: "Choose image",
      displayName: "Display name",
      linkedEmails: "Linked emails"
    },
    modelAccounts: {}
  },
  skillWorkshop: {},
  // Chat swarm summaries render before the lazy Activity catalog loads.
  // Keep their shared label in startup English; Activity replaces the full namespace on entry.
  activity: {
    status: {
      done: "Done"
    }
  },
  gatewayLogs: {
    title: "Logs",
    subtitle: "Gateway file logs (JSONL).",
    exportButton: "Export {label}",
    exportLabels: {
      filtered: "filtered",
      visible: "visible"
    },
    filter: "Filter",
    searchPlaceholder: "Search logs",
    autoFollow: "Auto-follow",
    file: "File: {file}",
    truncated: "Log output truncated; showing latest chunk.",
    empty: "No log entries."
  },
  pluginTabs: {
    unavailableTitle: "Plugin panel unavailable",
    unavailableSubtitle: "The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel."
  },
  logbook: {
    nav: {
      previousDay: "Previous day",
      nextDay: "Next day",
      today: "Today"
    },
    status: {
      capturing: "Capturing every {seconds}s",
      paused: "Capture paused",
      disabled: "Capture off",
      nodeHelp: "Device providing screen snapshots.",
      pending: "{count} frames queued",
      pendingHelp: "Snapshots waiting for the next analysis batch.",
      analyzing: "Analyzing\u2026",
      captureError: "Capture error",
      batchError: "Analysis error",
      modelMissing: "No vision model",
      modelMissingHelp: "Set plugins.entries.logbook.config.visionModel or configure tools.media models."
    },
    actions: {
      pause: "Pause",
      resume: "Resume",
      analyzeNow: "Analyze now"
    },
    empty: {
      title: "Nothing on the timeline yet.",
      subtitle: "Logbook is collecting snapshots; cards appear after the first analysis batch completes."
    },
    card: {
      keyframeAlt: "Screen snapshot from this activity",
      distractions: "Distractions"
    },
    stats: {
      title: "Day at a glance",
      focus: "{pct}% focus",
      tracked: "{duration} tracked"
    },
    standup: {
      title: "Daily standup",
      generate: "Generate",
      refresh: "Regenerate",
      empty: "Turn today's timeline into a ready-to-paste standup update."
    },
    ask: {
      title: "Ask your day",
      placeholder: "When did I review the gateway PR?",
      submit: "Ask"
    }
  },
  board: {
    label: "Session dashboard",
    tabsLabel: "Dashboard tabs",
    moreTabs: "More dashboard tabs",
    gridLabel: "Dashboard widgets",
    emptyTitle: "A clear board, ready for work",
    emptyHint: "Your agent can pin widgets here \u2014 try asking for a status card.",
    actionFailed: "The dashboard change could not be saved.",
    actionInProgress: "Another dashboard change is still being saved.",
    announcement: {
      moved: "Moved {title}.",
      resized: "Resized {title}.",
      removed: "Removed {title}.",
      granted: "Widget access allowed.",
      rejected: "Widget access rejected."
    },
    widget: {
      cellLabel: "Dashboard widget: {title}. Use arrow keys to navigate. Hold Alt and press an arrow key to move it.",
      moveHandle: "Move {title}",
      resizeHandle: "Resize {title}",
      menuLabel: "Widget options",
      moveToTab: "Move to tab",
      noOtherTabs: "No other tabs",
      resize: "Resize",
      autoHeight: "Auto height",
      remove: "Delete",
      needsApproval: "Needs approval",
      needsApprovalDetail: "This widget requested additional access.",
      networkAccess: "Network origins",
      hostTools: "Host tools and data",
      activeCapabilities: "Active widget capabilities",
      networkCapability: "Network: {capability}",
      toolCapability: "Tool: {capability}",
      granted: "Granted",
      allow: "Allow",
      allowFailed: "Could not allow widget access. Try again.",
      reject: "Reject",
      rejectFailed: "Could not reject widget access. Try again.",
      rejected: "Access rejected",
      rejectedDetail: "This widget stays inactive until it is removed or replaced.",
      appLoading: "Restoring app\u2026",
      appStaleTitle: "This pinned app is stale",
      appStaleDetail: "Its server, resource, or originating transcript is no longer available.",
      retry: "Retry",
      frameResolverMissing: "Widget content is unavailable.",
      sandboxUnavailable: "Widget sandbox host is unavailable.",
      accessDenied: "You don\u2019t have access to this widget in this conversation.",
      waitingForResult: "Waiting for the widget result.",
      runtimeError: "Script error: {message}",
      waitingForConnection: "Waiting for the connection. This view will recover automatically.",
      resourceUnavailable: "A widget resource could not load. Retry when the connection is available.",
      frameAuthorizationFailed: "Widget authorization failed after repeated refresh attempts.",
      sandboxOriginRequired: "Widget authorization failed after repeated refresh attempts. If the gateway runs behind a reverse proxy or tunnel that does not route the widget sandbox port, set mcp.apps.sandboxOrigin to a dedicated public origin routed to the sandbox listener.",
      errorTitle: "This widget could not load",
      errorDetail: "The problem is contained to this card.",
      actionErrorTitle: "Widget change failed",
      actionErrorDetail: "The dashboard kept the previous widget state.",
      errorShow: "Show details",
      kindMcp: "MCP",
      kindHtml: "HTML",
      kindPlugin: "Plugin",
      kindReport: "Report",
      kindWebsite: "Website",
      kindBrowserDashboard: "Browser dashboard",
      pluginLoading: "Loading plugin widget\u2026",
      disabledPlugin: "Widget from disabled plugin {pluginId}"
    }
  },
  connection: {
    browserSignIn: {
      title: "Sign in to continue loading content",
      description: "Your website sign-in has expired. Images and files cannot load until you sign in again. Your conversation and draft will stay open.",
      action: "Sign in",
      dismiss: "Not now",
      returnHint: "Finish signing in in the new tab, then return here. Visible attachments will retry automatically.",
      checkAgain: "Check again",
      checking: "Checking access\u2026",
      stillRequired: "Sign-in is still required. Finish signing in, then check again.",
      unavailable: "Could not verify access. Check your connection and try again."
    },
    connecting: "Connecting\u2026",
    starting: "Starting\u2026",
    restoring: "Restoring\u2026",
    "reload-required": "Refresh required",
    offline: "Disconnected",
    reconnecting: "Reconnecting\u2026",
    interruptedRetrying: "Connection to the Gateway was interrupted. Reconnecting automatically. (WebSocket {code})",
    interrupted: "Connection to the Gateway was interrupted. Check your connection and try again. (WebSocket {code})",
    restarting: "Restarting\u2026",
    suspending: "Suspending\u2026",
    suspended: "Suspended",
    retryNow: "Retry now",
    actionsUnavailable: "Actions are unavailable while the Gateway reconnects.",
    settingsChangesUnavailable: "Changes to settings are disabled while the Gateway is reconnecting.",
    sessionMoveRefreshFailed: "The session move was saved, but refreshing the list failed: {error}",
    sessionMoveUncertain: "The session move could not be confirmed. Refresh and check its group before retrying. {error}",
    sessionOperationCompletedPreviousConnection: "The session operation completed on the previous connection. Check the current session list before continuing.",
    sessionOperationCompletedPreviousConnectionWithRefreshError: "The session operation completed on the previous connection, but refreshing the current session list failed: {error}",
    scopeUpgrade: {},
    // Settings → Gateway copy lives in the lazy en-settings catalog; the anchor keeps its merge target.
    access: {},
    switchGateway: {
      title: "Switch to a different Gateway?",
      summary: "This link asks the browser to connect somewhere else.",
      current: "Current",
      next: "Link",
      note: "Anything you enter after switching goes to that host.",
      noteToken: "The link also carries a token for it.",
      noteScoped: "Your saved credential for {host} stays here and is not sent.",
      confirm: "Switch to {host}",
      cancel: "Keep current Gateway"
    },
    help: {
      title: "How to connect",
      step1: "Start the gateway on your host machine:",
      step2: "Get a tokenized dashboard URL:",
      step3: "Paste the Gateway URL and secret above, or open that URL directly.",
      docsLink: "Read the docs \u2192",
      copyCommand: "Copy command",
      copyCommandAria: "Copy command: {command}"
    }
  },
  // The Inbox loader renders before its diagnostics catalog loads.
  attention: {
    issues: "Inbox"
  },
  standingGrants: {
    title: "Standing grants",
    description: "Allow-always on an automation approval mints a standing grant for that exact command. Revoking one makes the next occurrence ask again.",
    historyTitle: "Approval history",
    empty: "No standing grants. Answer an automation approval with Always allow to mint one.",
    stateUntilRevoked: "Until revoked",
    stateExpiresIn: "Expires in {count}d",
    stateExpired: "Expired",
    stateRevoked: "Revoked",
    revoke: "Revoke",
    revoking: "Revoking\u2026",
    columns: {
      automation: "Automation",
      command: "Command",
      uses: "Uses",
      state: "State"
    }
  },
  approvalHistory: {
    description: "Terminal exec, plugin, and system-agent approvals recorded by this gateway, newest first.",
    loading: "Loading approval history\u2026",
    loadingMore: "Loading\u2026",
    loadMore: "Load more",
    empty: "No resolved approvals in the rolling 30-day window.",
    retention: "Approval history is a rolling 30-day window.",
    offline: "Connect to the gateway to load approval history.",
    invalidResponse: "The gateway returned an invalid approval history response.",
    unknown: "Unknown",
    notApplicable: "N/A",
    columns: {
      resolved: "Resolved",
      kind: "Kind",
      request: "Request",
      decision: "Decision",
      reason: "Resolution reason",
      source: "Source agent / session",
      resolver: "Resolver"
    },
    kinds: {
      exec: "Exec",
      plugin: "Plugin",
      systemAgent: "System agent"
    },
    statuses: {
      allowed: "Allowed",
      denied: "Denied",
      expired: "Expired",
      cancelled: "Cancelled"
    },
    decisions: {
      allowOnce: "Allow once",
      allowAlways: "Always allow",
      deny: "Deny"
    },
    reasons: {
      user: "User decision",
      timeout: "Timed out",
      malformedVerdict: "Malformed verdict",
      noRoute: "No route",
      runAborted: "Run aborted",
      gatewayRestart: "Gateway restart",
      storageCorrupt: "Storage corrupt"
    }
  },
  commandPalette: {},
  palette: {
    placeholder: "Search or start a task\u2026",
    categories: { navigation: "Navigation" }
  },
  dreaming: {},
  modelProviders: {},
  searchPage: {},
  usage: {
    common: {
      emptyValue: "\u2014",
      unknown: "unknown"
    },
    loading: {
      title: "Usage Overview",
      badge: "Loading"
    },
    metrics: {
      tokens: "Tokens",
      cost: "Cost",
      session: "session",
      sessions: "sessions"
    },
    heatmap: {
      title: "Token Activity",
      subtitle: "Daily token intensity for the selected range, up to one year.",
      cellTokens: "{tokens} tokens",
      less: "Less",
      more: "More"
    },
    providerUsage: {
      title: "Provider plans & billing",
      subtitle: "Live plan, quota, balance, and budget data reported by configured providers.",
      stalled: "Provider usage did not finish loading. Refresh to retry.",
      unavailable: "Provider usage is unavailable; the last request failed. Refresh to retry.",
      balance: "Balance",
      spend: "Usage",
      budget: "Budget",
      today: "Today",
      last7Days: "7 days",
      lastDays: "{count} days",
      dailyCost: "Daily provider cost",
      requests: "{count} requests",
      inputTokens: "{count} input",
      cacheTokens: "{count} cache",
      outputTokens: "{count} output",
      topModels: "Top models",
      costCategories: "Cost categories",
      remaining: "{percent}% left",
      resets: "Resets {date}"
    },
    presets: {},
    scope: {},
    filters: {},
    query: {},
    export: {},
    cacheStatus: {},
    empty: {},
    daily: {},
    costWindows: {},
    breakdown: {
      output: "Output",
      input: "Input",
      cacheWrite: "Cache Write",
      cacheRead: "Cache Read",
      total: "Total",
      tokensByType: "Tokens by Type",
      costByType: "Cost by Type"
    },
    overview: {
      title: "Usage Overview"
    },
    sessions: {},
    details: {
      noUsageData: "No usage data for this session.",
      duration: "Duration",
      modelMix: "Model Mix",
      filtered: "(filtered)",
      close: "Close session details",
      noTimeline: "No timeline data",
      loadFailed: "Could not load {detail}: {error}",
      noDataInRange: "No data in range",
      usageOverTime: "Usage Over Time",
      rangeStart: "Range start",
      rangeEnd: "Range end",
      reset: "Reset",
      perTurn: "Per Turn",
      cumulative: "Cumulative",
      turnRange: "Turns {start}\u2013{end} of {total}",
      assistantOutputTokens: "Assistant output tokens",
      userToolInputTokens: "User + tool input tokens",
      tokensWrittenToCache: "Tokens written to cache",
      tokensReadFromCache: "Tokens read from cache",
      noContextData: "No context data",
      contextOutOfDate: "These context details are out of date. Refresh usage and try again.",
      systemPromptBreakdown: "System Prompt Breakdown",
      collapse: "Collapse",
      collapseAll: "Collapse All",
      expandAll: "Expand All",
      baseContextPerMessage: "Base context per message",
      system: "System",
      systemShort: "Sys",
      skills: "Skills",
      tools: "Tools",
      files: "Files",
      ofInput: "of input",
      of: "of",
      timelineFiltered: "timeline filtered",
      loadedIntervalMessages: "Loaded conversation \xB7 selected interval",
      conversation: "Conversation",
      noMessages: "No messages",
      tool: "Tool",
      toolResult: "Tool result",
      hasTools: "Has tools",
      searchConversation: "Search conversation",
      filterByRole: "Filter by role",
      filterByTool: "Filter by tool",
      you: "You",
      noMessagesMatch: "No messages match the filters."
    },
    mosaic: {}
  },
  // Login copy lives in the lazy en-login catalog; the anchor keeps its merge target.
  login: {},
  chat: {
    sessionDetails: {
      menu: "Session details",
      title: "Details",
      close: "Close details",
      session: "Session details",
      environment: "Environment",
      context: "Context",
      contextMessages: "Messages & other",
      contextFiles: "Workspace memory",
      contextTools: "Tool schemas",
      contextSkills: "Skills",
      contextSystem: "System prompt",
      contextFree: "Free space",
      contextUnverified: "Unverified",
      contextEstimate: "Last saved prompt \xB7 token sizes estimated from characters. Messages include other untracked context.",
      contextLoading: "Loading context breakdown\u2026",
      contextError: "Couldn't load the context breakdown. Try refreshing.",
      contextOffline: "Connect to the Gateway to load the context breakdown.",
      contextUnavailable: "No matching context report. Send a message to capture one.",
      contextHeadroom: "{tokens} tokens until the last run's prompt budget",
      contextReserve: "{tokens} tokens reserved outside this prompt budget",
      contextCompact: "Compact session",
      contextCompacting: "Compacting\u2026",
      worktree: "Worktree",
      changes: "Changes",
      subagents: "Subagents",
      processes: "Processes",
      allSubagents: "All subagents",
      allProcesses: "All processes",
      processesError: "Couldn't load processes.",
      planSteps: "{completed} of {total} steps",
      showMore: "Show {count} more",
      showLess: "Show less",
      stopped: "Stopped",
      tally: {
        done: "{count} done",
        failed: "{count} failed",
        stopped: "{count} stopped",
        running: "{count} running",
        queued: "{count} queued"
      },
      createdBy: "Created by",
      owner: "Owner",
      participants: "{count} participants",
      moreParticipants: "{count} more participants",
      workspaceUnavailable: "Workspace unavailable",
      allChanges: "All changes",
      pullRequests: "Pull requests",
      noPullRequests: "No pull requests",
      automations: "Automations",
      progressOptions: "Task progress options",
      hideProgress: "Don't show task progress again",
      collapseDefault: "Collapse task progress by default",
      settings: "Task progress settings",
      progressHidden: "Task progress hidden in this browser.",
      automationError: "Couldn't load automations.",
      automationUnavailable: "Automations unavailable for this session.",
      automationOffline: "Offline \xB7 last-known automations",
      automationLoading: "Loading automations\u2026",
      automationEmpty: "No automations for this session",
      automationMore: "Load more automations",
      automationAttention: "Needs attention",
      automationPaused: "Paused",
      automationEnabled: "Enabled"
    },
    agentDatabaseWarming: "This agent is still starting. Retry in a moment.",
    historyRequestTimedOut: "Chat history request timed out. Retry to load the conversation.",
    clawhub: {
      retryStatus: "Status unavailable \xB7 Retry",
      viewDetails: "View details"
    },
    modelAccounts: {
      section: "Account",
      automatic: "Automatic (new-chat default)",
      manage: "Manage saved accounts\u2026"
    },
    mentions: {
      menu: "Mention a person",
      empty: "No people found",
      truncated: "Keep typing to find more people.",
      online: "Online",
      offline: "Offline",
      unavailable: "Could not load people. Try again.",
      limit: "You can mention up to 10 people per message.",
      selectedLabel: "Will notify",
      selected: "Will notify: {names}",
      remove: "Remove mention",
      restoreFailed: "Mention selection could not be restored. Edit this message and select its recipients again.",
      unsupported: "Human mentions are not available in this mode. Remove the selected mentions or send from a normal chat."
    },
    cloudWorkerFailed: "Runner failed: {error}",
    errorDetails: "Error details",
    errorReplySummary: "Couldn't finish this reply. Check the conversation before trying again.",
    recovery: {
      retrying: "Retrying\u2026",
      retryingIn: "Retrying in {seconds}s",
      tryingFallback: "Trying fallback model\u2026",
      failedTitle: "Unable to finish this reply",
      failedHelp: "Automatic recovery has stopped. Check any completed work before trying again.",
      tryAgain: "Try again",
      continuePrompt: "Continue from where you stopped. Check which actions already completed before retrying anything."
    },
    errorBusySummary: "OpenClaw is busy. Check status before trying again.",
    errorSignInSummary: "Couldn't sign in to the AI service. Sign in again under Models.",
    errorStartSummary: "Couldn't start this conversation. Open Settings \u2192 Logs for details.",
    checkStatus: "Check status",
    details: "Details",
    copyError: "Copy error",
    providerAccessRemoved: "This reply stopped because the provider was signed out. Sign in again or choose another model.",
    providerReview: {},
    providerPolicy: {
      bufferingTitle: "Cyber safety review",
      bufferingBody: "OpenAI is reviewing this response for cyber safety.",
      blockedTitle: "Cyber policy block",
      blockedBody: "OpenAI blocked this response under its cyber policy.",
      fallbackTitle: "Provider changed the model",
      fallbackBody: "OpenAI routed this response to {model}.",
      fallbackUnknownBody: "OpenAI routed this response to another model.",
      escalatedTitle: "Retried on Daybreak",
      escalatedBody: "OpenAI declined this request; retried on {model}.",
      unavailableTitle: "Daybreak unavailable",
      unavailableBody: "OpenAI declined this request; {model} is not authorized."
    },
    diskSpace: {
      warningTitle: "Cloud session disk space is low",
      criticalTitle: "Cloud session disk space is critically low",
      warningBody: "{percent}% used \xB7 {free} free. Delete unneeded files or stop the cloud worker before large writes.",
      criticalBody: "{percent}% used \xB7 {free} free. New writes may fail and stop the agent. Delete unneeded files or stop the cloud worker before large writes."
    },
    workerRuntimeInstall: {
      transferringTitle: "Updating worker runtime \xB7 {transferred} of {total} ({percent}%)",
      installingTitle: "Installing worker runtime",
      transferringBody: "Transferring the new worker runtime to this device: {transferred} of {total} ({percent}%). The next turn starts when it finishes.",
      installingBody: "Installing the new worker runtime on this device."
    },
    sendErrors: {
      outboxPayloadCopied: "This queued message was copied from another tab. Check the conversation and retry only if it has not arrived.",
      outboxPayloadCapacity: "Browser attachment storage is full. Try a smaller batch or send/discard queued messages to free space. No new message was sent; your input is retained.",
      outboxPayloadUnavailable: "Browser attachment storage is unavailable. Allow browser storage and close older dashboard tabs before reconnecting and retrying. No new message was sent.",
      outboxPayloadMissing: "Queued attachments are missing or unreadable. This may be a stale copy from another tab. Check the conversation, then discard this row and attach the files again if needed. No new message was sent.",
      activeLeafChanged: "The session switched branches \u2014 review and resend."
    },
    waitingForApproval: "Waiting for approval\u2026",
    waitingOnSubagents: "Waiting on subagents",
    waitingForMessage: "Waiting for a message",
    turnElapsed: "Total time since your message, including subagent waits",
    waitingOnSubagent: "Waiting on {name}",
    subagentsRunning: "{count} subagents running",
    subagentsRunningOne: "1 subagent running",
    startupStatus: {
      retrying: "Retrying\u2026 {attempt}/{maxAttempts}",
      preparingWorkspace: "Preparing workspace\u2026",
      namingWorktree: "Naming worktree\u2026",
      creatingWorktree: "Creating worktree\u2026",
      runningSetup: "Running setup\u2026",
      provisioningEnvironment: "Provisioning environment\u2026",
      startingFromSnapshot: "Starting from snapshot\u2026",
      preparingCloudEnvironment: "Preparing cloud environment\u2026",
      savingSnapshot: "Saving snapshot\u2026",
      preparingContext: "Preparing this turn\u2026",
      waitingForTurn: "Waiting for turn to start\u2026",
      memoryFlushing: "Saving conversation memory\u2026",
      startingModel: "Waiting for a response",
      waitingForLocalModel: "Waiting for the local model to respond",
      waitingForModelSlot: "Waiting for a free model slot",
      waitingForState: "Temporarily busy\u2014retrying\u2026"
    },
    archivedSessionDisabled: "This session is archived. Unarchive it to continue the conversation.",
    subagentViewOnly: "View-only subagent",
    subagentSessionDisabled: "Continue in {parent}.",
    processesPanel: { title: "Processes", refresh: "Refresh processes" },
    subagentsPanel: {
      title: "Subagents",
      back: "Back to Subagents",
      running: "Running ({count})",
      finished: "Finished ({count})",
      callsOne: "{count} call",
      callsMany: "{count} calls",
      callsAtLeast: "{count}+ calls",
      empty: "No subagents in this conversation.",
      noRunning: "No running subagents",
      refresh: "Refresh subagents",
      stop: "Stop {name}",
      stopping: "Stopping\u2026",
      elapsed: "Elapsed time",
      duration: "Run duration"
    },
    parentSession: "the parent session",
    openParentSession: "Open parent session",
    parentSessionUnavailable: "Parent session information is unavailable.",
    sessionRoute: {
      chooseTitle: "Choose a session",
      multipleMatches: "More than one session matches {shortId}.",
      additionalMatches: "Search results remain. Use a longer id prefix.",
      notFoundTitle: "Session not found",
      notFoundExplanation: "The session may have been removed, or the link may be incorrect.",
      goToMain: "Go to main session",
      viewSessions: "View sessions",
      catalogShareUnavailable: "This shared session route is unavailable.",
      catalogShareInvalid: "This {catalog} share URL is invalid."
    },
    commandResults: {
      startingNewThread: "Starting new session...",
      resettingThread: "Resetting session...",
      stoppingCurrentRun: "Stopping current run...",
      chatHistoryCleared: "Chat history cleared.",
      emptyExport: "There are no messages to export yet.",
      exportPathUnsupported: "Control UI exports Markdown through your browser. Run /export without a file path.",
      unknownCommand: "Unknown command: `{command}`",
      options: "Options: {options}.",
      sessionUnavailable: "Session capability is unavailable",
      help: {
        availableCommands: "Available Commands",
        agentCommand: "agent",
        openMenu: "Type `/` to open the command menu."
      },
      compaction: {
        failed: "Compaction failed.",
        failedWithReason: "Compaction failed: {reason}",
        tokenSummary: " ({before} -> {after} tokens)",
        succeeded: "Context compacted successfully",
        skipped: "Compaction skipped.",
        skippedWithReason: "Compaction skipped: {reason}"
      },
      model: {
        current: "**Current model:** {model}",
        available: "**Available:** {models}",
        more: " +{count} more",
        getFailed: "Failed to get model info: {error}",
        set: "Model set to {model}.",
        setFailed: "Failed to set model: {error}"
      },
      thinking: {
        current: "Current thinking level: {level}.",
        getFailed: "Failed to get thinking level: {error}",
        reset: "Thinking level reset to default.",
        resetFailed: "Failed to reset thinking level: {error}",
        unrecognized: 'Unrecognized thinking level "{level}". Valid levels: {options}.',
        unsupported: 'Unsupported thinking level "{level}" for this model. Valid levels: {options}.',
        set: "Thinking level set to {level}.",
        setFailed: "Failed to set thinking level: {error}"
      },
      verbose: {
        current: "Current verbose level: {level}.",
        getFailed: "Failed to get verbose level: {error}",
        unrecognized: 'Unrecognized verbose level "{level}". Valid levels: off, on, full.',
        set: "Verbose mode set to {level}.",
        setFailed: "Failed to set verbose mode: {error}"
      },
      fast: {
        autoValue: "auto ({seconds} sec)",
        on: "on",
        off: "off",
        sourceSession: " (session)",
        sourceAgent: " (default: agent)",
        sourceModel: " (default: model)",
        sourceDefault: " (default)",
        current: "Current fast mode: {value}",
        options: "on, off, auto ({seconds} sec), default, status",
        getFailed: "Failed to get fast mode: {error}",
        reset: "Fast mode reset to default.",
        resetFailed: "Failed to reset fast mode: {error}",
        unrecognized: 'Unrecognized fast mode "{mode}". Valid levels: on, off, auto, default, status.',
        setAuto: "Fast mode set to auto.",
        enabled: "Fast mode enabled.",
        disabled: "Fast mode disabled.",
        setFailed: "Failed to set fast mode: {error}"
      },
      usage: {
        noActiveThread: "No active session.",
        notAvailable: "n/a",
        title: "Session Usage",
        inputTokens: "Input: {count} tokens",
        outputTokens: "Output: {count} tokens",
        totalTokens: "Total: {count} tokens",
        context: "Context: {percent} of {total}",
        promptBudget: "Prompt budget (last run): {percent} of {total}",
        model: "Model: {model}",
        failed: "Failed to get usage: {error}"
      },
      agents: {
        none: "No agents configured.",
        title: "**Agents** ({count})",
        default: "default",
        runtime: " \xB7 runtime {runtime}",
        failed: "Failed to list agents: {error}"
      },
      steer: {
        timeout: "The active run ended before the steer message was accepted.",
        failed: "Steer failed before it reached the run; try again.",
        usage: "Usage: `/steer <message>`",
        succeeded: "Steered.",
        requestFailed: "Failed to steer: {error}"
      },
      redirect: {
        timeout: "The active run ended before the redirect message was accepted.",
        failed: "Redirect failed before it reached the run; try again.",
        usage: "Usage: `/redirect <message>`",
        succeeded: "Redirected.",
        requestFailed: "Failed to redirect: {error}"
      }
    },
    sessionSharing: {
      menu: "Session sharing",
      share: "Share",
      current: "Session visibility: {visibility}",
      visibility: "Visibility",
      shared: "Shared",
      readOnly: "Read-only",
      suggest: "Suggest",
      draft: "Draft",
      publishDraft: "Publish draft",
      owner: "Owner",
      members: "Members",
      selected: "Member",
      noPeople: "No paired people found.",
      readOnlyNotice: "Only the session owner and members can act in this session.",
      scopeReadOnlyNotice: "Sending messages is unavailable with your current access.",
      publicAccess: "Public access",
      publicIndicator: "Public",
      worldReadable: "Public \u2014 anyone can read without signing in.",
      notPublic: "Only signed-in people with access can view this session.",
      enablePublicAccess: "Enable public access\u2026",
      disablePublicAccess: "Disable public access",
      copyPublicLink: "Copy public link",
      publicConfirmTitle: "Make this session world-readable?",
      publicConfirmMessage: `Anyone with the public link can read existing and future conversation text, including all user and assistant messages and progress, plus tool names, short argument summaries, and images without signing in.

Reasoning, tool-result text, and private dashboards stay hidden. Image contents are not redacted. Review for private information before sharing; disabling access cannot recall downloaded copies.`,
      publicConfirmEnable: "Make public",
      publicEnabled: "Public access enabled. Copy the public link from Session sharing.",
      publicDisabled: "Public access disabled.",
      publicUnavailable: "Public access requires a saved, non-incognito session."
    },
    reactions: {
      add: "Add reaction",
      quick: "Quick reactions",
      emoji: "Emoji",
      more: "More\u2026",
      back: "Back to quick reactions",
      search: "Search emoji\u2026",
      noMatches: "No matching emoji",
      you: "You",
      andOthers: "{names} and {count} others",
      reactedWith: "{names} reacted with {emoji}"
    },
    sessionSuggestions: {
      suggest: "Suggest",
      suggestMessage: "Suggest message",
      attachmentsUnsupported: "Remove attachments before submitting a text suggestion.",
      sendNow: "Send {author}'s suggestion now",
      queue: "Queue {author}'s suggestion",
      edit: "Edit {author}'s suggestion",
      dismiss: "Dismiss {author}'s suggestion",
      typing: "{name} is typing\u2026",
      typingMany: "{names} are typing\u2026",
      typingSeveral: "Several people are typing\u2026",
      typingOthers: "{count} others",
      otherCollaborators: "Other collaborators",
      typingDraftState: "is typing...",
      pausedDraftState: "Draft",
      state: {
        pending: "Pending",
        accepted: "Accepted",
        dismissed: "Dismissed"
      }
    },
    sessionHeader: {
      agentContext: "Session and workspace for {agent}",
      renameTooltip: "Rename session",
      renameAria: "Rename session {title}",
      renameInputAria: "Session title",
      renameInputPlaceholder: "Session title",
      openParent: "Open parent session {title}",
      subagentsRunning: "Subagents \xB7 {count} running",
      layout: "Layout",
      panels: "Panels",
      continueInTerminal: {
        action: "Continue in terminal\u2026",
        title: "Continue in terminal",
        description: "Copy this command to continue the current session. It is safe to paste in common terminals and shells.",
        authNote: "The command contains no credentials. The terminal authenticates independently, and the session's access controls still apply.",
        disconnected: "Connect to the Gateway to continue this session in a terminal.",
        queryRouted: "Query-routed Gateway URLs cannot create credential-free continuation commands because authentication and stored device scope are not query-aware. Use a manually authenticated CLI target or a queryless configured Gateway URL.",
        unavailable: "This session or Gateway address cannot be continued in a terminal."
      },
      workspaceAria: "Workspace actions for {workspace}",
      revealFinder: "Reveal in Finder",
      revealFileExplorer: "Reveal in File Explorer",
      revealFileManager: "Open in file manager",
      copyPath: "Copy path",
      copyBranch: "Copy branch name",
      copied: "Copied",
      branches: "Versions",
      versionsHelpLabel: "About versions",
      versionsHelp: "Saved copies of this conversation from rewinds or repairs. You can return to an earlier version here.",
      branchSwitchUnavailable: "Versions cannot be switched while the agent is working.",
      untitledBranch: "Untitled version",
      oneMessage: "{count} message",
      messages: "{count} messages",
      activeBranch: "Current version"
    },
    board: {
      faceLabel: "Session face",
      chatFace: "Chat",
      splitFace: "Split",
      dashboardFace: "Dashboard",
      dockMenu: "Chat dock: {dock}",
      dockLeft: "Dock chat left",
      dockRight: "Dock chat right",
      dockBottom: "Dock chat bottom",
      resizeDock: "Resize chat dock",
      enterFullscreen: "Enter fullscreen",
      exitFullscreen: "Exit fullscreen",
      fullscreenUnavailable: "Fullscreen is unavailable in this browser",
      fullscreenFailed: "Could not change fullscreen mode: {error}",
      workboardCard: "Workboard card: {title}, {status}",
      defaultTab: "Main",
      mockPlaceholder: "Board view \xB7 {tabs} tabs \xB7 {widgets} widgets",
      resetTitle: "Reset conversation?",
      resetDescription: "The conversation context resets. Your dashboard stays."
    },
    catalog: {
      remoteViewOnly: "This session is on a paired device and is view-only.",
      unsupportedViewOnly: "This external session source is view-only.",
      sessionMenu: "External session actions",
      openInOpenClaw: "Open in OpenClaw",
      importToOpenClaw: "Import to OpenClaw",
      importComplete: "Imported {count} transcript items.",
      importUnchanged: "The imported transcript is up to date.",
      importIncomplete: "Imported {count} transcript items. Older history exceeded the import limit.",
      openImportedSession: "Open imported session",
      openInTerminal: "Open in terminal",
      deleteSession: "Delete",
      deleteSessionConfirm: "Delete this external session from OpenClaw? Make sure no other runner is using it. Beamed sessions are deleted permanently. Sessions kept by another tool, such as Codex, are archived there and may be restorable.",
      terminalUnavailable: "Terminal opening is unavailable for this session."
    },
    taskSuggestions: {
      eyebrow: "Suggested task \xB7 in {repo}",
      startSession: "Start in a new session",
      startOptions: "Choose where to start the task",
      startWorktree: "Start in a new worktree",
      chooseRepository: "Choose repository",
      repositoryFolder: "Repository folder",
      chooseRepositoryHelp: "Choose a Git repository with a commit. Your task will start in a new worktree; its instructions are preserved.",
      startCurrentSession: "Start in this session",
      copyPrompt: "Copy prompt",
      copyPromptFailed: "Couldn't copy the prompt to the clipboard",
      promptCopied: "Copied",
      showInstructions: "Show instructions",
      hideInstructions: "Hide instructions",
      previous: "Previous suggested task",
      next: "Next suggested task",
      starting: "Starting\u2026",
      dismiss: "Dismiss {title}",
      started: "Task started",
      startUnconfirmed: "Couldn't confirm the task started. Retry checks the same task.",
      adminRequired: "Administrator access is required to start suggested tasks."
    },
    pullRequests: {
      open: "Open",
      draft: "Draft",
      merged: "Merged",
      closed: "Closed"
    },
    usageRemaining: "Usage Remaining",
    view: {
      menu: "View",
      speechBubbles: "Speech bubbles",
      activityDetails: "View activity details",
      workingDetails: "Agent is working. View details",
      reasoning: "Reasoning",
      toolCalls: "Tool calls",
      commentary: "Keep commentary"
    },
    sendShortcut: "Send shortcut",
    sendShortcutEnter: "Enter",
    sendShortcutModifierEnter: "\u2318/Ctrl+Enter",
    followUpMode: "Follow-ups while the agent is working",
    followUpModeQueue: "Queue until the run ends",
    followUpModeServer: "Server default ({mode})",
    followUpModeLoading: "loading\u2026",
    followUpModeSteer: "Steer into the active run",
    followUpModeOverriding: "Overriding server default ({mode})",
    followUpModeReset: "Reset to server default",
    catalogOpenTarget: "Open external sessions in",
    catalogOpenTargetViewer: "OpenClaw viewer",
    catalogOpenTargetTerminal: "Terminal",
    catalogOutputTruncated: "[Output truncated]",
    onboardingDisabled: "Disabled during setup",
    commandPaletteTitle: "Search or jump to\u2026 (\u2318K)",
    openCommandPalette: "Open command palette",
    updating: "Updating\u2026",
    actions: {
      copyAsMarkdown: "Copy as markdown",
      dismissError: "Dismiss error",
      exitFocusMode: "Exit focus mode",
      scrollToLatest: "Scroll to latest"
    },
    markdown: {
      truncated: "\u2026 truncated ({total} chars, showing first {shown})."
    },
    mermaid: {
      title: "Mermaid diagram",
      options: "Diagram options",
      diagram: "Show diagram",
      source: "Show source",
      copySource: "Copy source",
      expand: "Expand diagram",
      rendering: "Rendering diagram\u2026",
      error: "This diagram could not be rendered. Check the source or simplify the diagram.",
      rendererError: "The Mermaid renderer could not load or finish. Reload the dashboard; if this continues, check proxy or authentication rules for its renderer asset URLs.",
      imageError: "The diagram image could not be displayed. Reload the dashboard to try again."
    },
    codeBlock: {},
    workspaceConflict: {
      titleOne: "1 cloud workspace conflict",
      titleMany: "{count} cloud workspace conflicts",
      description: "OpenClaw kept your local versions and applied the other cloud changes. Inspect the staged result or take its version for a conflicted path.",
      summary: "Local versions kept; inspect or take the cloud version.",
      showCommands: "Show commands",
      morePaths: "+{count} more paths",
      stagedResult: "Staged cloud result",
      copyStagedResult: "Copy staged result ref",
      inspectCloud: "Inspect the first cloud version",
      takeCloud: "Take the first cloud version",
      copyInspectCommand: "Copy cloud inspect command",
      copyTakeCommand: "Copy take-cloud command",
      commandHelp: "Run these in Bash or zsh (Git Bash on Windows). If inspect says the path does not exist, the cloud deleted it; verify and remove the local path manually. If checkout reports a file/directory conflict, move or remove the blocking local path, then retry. If the staged ref is missing, the notice is stale; do not change the local path.",
      commandsUnavailable: "This filename contains terminal control characters, so OpenClaw will not build a copyable shell command for it. Inspect the staged ref directly and enter the path manually with care.",
      dismiss: "Dismiss workspace conflict notice",
      eventSender: "Cloud workspace",
      eventTitleOne: "Cloud result applied with 1 conflict",
      eventTitleMany: "Cloud result applied with {count} conflicts",
      eventDescription: "Local versions were kept for these paths; other cloud changes were applied."
    },
    compaction: {
      label: "Compacted history",
      savedTokens: "saved {count} tokens"
    },
    sessionReset: {
      label: "Session reset",
      description: "The earlier conversation was cleared."
    },
    outboxRecoveryReviewTitle: "Review in this chat?",
    outboxRecoveryConfirm: "Add this saved copy to \u201C{chat}\u201D for review? Nothing will be sent.",
    outboxRecoveryRestore: "Restore",
    outboxRecoveryConflict: "Keep or clear the draft and pending messages in this chat first, or open another non-Incognito chat. Your saved copy is unchanged.",
    outboxRecoveryStorageFailed: "We could not access your saved messages. Reload to try again. Do not clear browser site data if you want to keep them.",
    outboxRecoveryFull: "There are more saved messages than we can show. Review or delete the copies below to make room. The remaining messages are still saved in this browser.",
    outboxRecoveryDraft: "Draft",
    outboxRecoveryQueued: "Unsent",
    outboxRecoverySource: "from {chat}",
    outboxRecoveryUpdated: "Last updated {time}",
    outboxRecoveryGoal: "Includes an unsent goal change",
    outboxRecoveryReply: "Reply to: {text}",
    outboxRecoveryAttachments: "Attachments: {files}",
    outboxRecoveryUnconfirmedLabel: "may have been sent",
    outboxRecoveryUnconfirmed: "Delivery unconfirmed. This message may already have been sent. Check the original chat before sending it again.",
    outboxRecoveryAttachmentMissing: "An attachment could not be loaded. Review the message and reattach the file before sending.",
    outboxRecoveryDelete: "Delete",
    outboxRecoveryDeleteTitle: "Delete this saved copy?",
    outboxRecoveryDeleteConfirm: "This removes the draft and any saved messages or attachments shown with it from this browser. It cannot be undone. Messages already sent to a chat will not be deleted.",
    outboxRecoveryDeleteConflict: "This saved copy changed while you were reviewing it. Nothing was deleted. Reload and review it again.",
    privateDraftReload: {
      blocked: "An unsent Incognito draft is keeping this tab open. Review it before refreshing.",
      review: "Review private draft",
      title: "Unsent Incognito draft",
      description: "This draft stays only in this tab. Copy its text or download its attachments before discarding it to refresh. Keeping this tab open leaves the draft unchanged.",
      text: "Draft text",
      copy: "Copy text",
      goal: "This draft includes an unsent goal change.",
      reading: "Some attachments are still being read. Keep this tab open, then review the draft again when they finish.",
      changed: "The draft changed while you were reviewing it. It has not been discarded; review the current draft before refreshing.",
      copyFailed: "The text could not be copied. Select it in the draft field and copy it manually.",
      attachmentUnavailable: "This attachment is no longer available to download. Keep the draft open and recover the original file before discarding it.",
      download: "Download {name}",
      discard: "Discard this draft and refresh",
      keep: "Keep in this tab",
      unavailable: "The private draft could not be opened. It remains in this tab; try Review private draft again."
    },
    incognitoExpiredTitle: "Incognito session expired",
    incognitoExpiredBody: "Incognito sessions last for 24 hours or until the Gateway restarts. Your unsent input stays in this tab.",
    newIncognitoSession: "New Incognito session",
    restartRecoveryTitle: "This task was interrupted by a restart.",
    restartRecoveryDisabled: "Your transcript is safe. Resume to continue in this session.",
    restartRecoveryNewSession: "This provider cannot safely resume tool work here. Your transcript can continue in a new session.",
    resumeSession: "Resume",
    resumeInNewSession: "Resume in new session",
    resumingSession: "Resuming\u2026",
    systemNotice: {
      event: "{count} system event",
      events: "{count} system events",
      updatesNotDelivered: "Updates not delivered",
      guardian: {
        approvedSummary: "Guardian approved {action}.",
        deniedLabel: "Guardian denied",
        deniedSummary: `{action} \xB7 risk: {risk}

{rationale}`,
        warningLabel: "Guardian warning",
        warningFallback: "Guardian stopped the requested action.",
        strictReviewRequiredLabel: "Guardian review required",
        strictReviewRequiredSummary: "Guardian is reviewing this action before it can continue.",
        requestedAction: "Requested action",
        unknownRisk: "unknown",
        noRationale: "No rationale was provided."
      },
      restartRecovery: {
        label: "System \xB7 restart recovery",
        interrupted: "The Gateway restarted. Automatic recovery was interrupted before the agent could resume. Send a message to continue.",
        cancelled: "The Gateway restarted. Automatic recovery was cancelled before the agent could resume. Send a message to continue."
      },
      automationRecovery: {
        label: "System \xB7 automation recovery",
        summary: "An automation failed \u2014 asked the agent to investigate and continue if needed."
      },
      gatewayRestarted: {
        label: "System \xB7 gateway restarted"
      },
      cliHarnessContext: {
        label: "System \xB7 injected context"
      },
      claudeCliTaskNotification: {
        label: "System \xB7 background task"
      },
      pluginSteering: {
        label: "{plugin} guidance"
      }
    },
    skillLearned: {
      label: "Learned",
      created: "Created",
      updated: "Updated",
      archived: "Archived",
      restored: "Restored",
      open: "Open {name} in Skill Workshop",
      undo: "Undo",
      undoing: "Undoing\u2026",
      undone: "Undone",
      undoError: "Could not undo: {error}"
    },
    progressLabels: {
      shelling: "Shelling",
      scuttling: "Scuttling",
      clawing: "Clawing",
      pinching: "Pinching",
      molting: "Molting",
      bubbling: "Bubbling",
      tiding: "Tiding",
      reefing: "Reefing",
      cracking: "Cracking",
      sifting: "Sifting",
      brining: "Brining",
      nautiling: "Nautiling",
      krilling: "Krilling",
      barnacling: "Barnacling",
      lobstering: "Lobstering",
      tidepooling: "Tidepooling",
      pearling: "Pearling",
      snapping: "Snapping",
      surfacing: "Surfacing"
    },
    turnRecap: {
      doneIn: "Done in {duration}",
      tokens: "{count} output tokens",
      tokensOne: "1 output token"
    },
    commands: {},
    skills: {
      menu: "Skill references",
      label: "Skills",
      loading: "Loading skills\u2026"
    },
    splitView: {
      chooseConversation: "Choose a conversation",
      missingOwner: "Select this pane, then choose Home or a conversation in the sidebar to restore it.",
      open: "Open split view",
      splitRight: "Split right",
      splitDown: "Split down",
      closePane: "Close pane",
      panePosition: "Column {column}, row {row} ({pane})",
      dropSplit: "Split",
      dropOpenHere: "Open here"
    },
    sidebar: {
      mySessions: "My sessions",
      updateMacAndGateway: "Update Mac app + Gateway",
      updateGateway: "Update Gateway",
      serverUpdatedTitle: "Server updated",
      serverUpdatedRefresh: "Refresh for full capabilities",
      threads: "Sessions",
      otherSessions: "Other",
      groups: "Groups",
      coding: "Coding",
      catalogViewOptions: "View options",
      reorderItem: "Reorder {item}",
      moveUp: "Move up",
      moveDown: "Move down",
      hideFromSidebar: "Hide from sidebar",
      sectionHidden: "{section} hidden.",
      sectionHiddenRecovery: "Show it again in Settings > Appearance > Sidebar.",
      hiddenSessionSections: "Hidden session sections",
      showSessionSection: "Show",
      catalogGroupByProject: "Project",
      catalogGroupByPerson: "Person",
      openSessionMenu: "Open session menu",
      sortBy: "Sort by",
      sortCreated: "Created",
      menuFilters: "Filters",
      menuDisplay: "Display",
      hideEmpty: "Hide empty",
      activeFilterCount: "Active filters: {count}",
      sortSessions: "Filter & sort",
      sessionSources: "Session sources",
      showAllSessions: "Show all sessions",
      noActiveSessionsForFilter: "No active sessions match this filter",
      sortUpdated: "Last updated",
      sessionMenu: "Actions for {session}",
      sessionMenuMany: "Actions for {count} sessions",
      catalogDiscoveryHelp: "{error}. Configure automatic session discovery in Settings > Appearance > Session sources.",
      catalogPaginationFailed: "Session catalog returned a repeated page cursor",
      catalogPageMissingHost: "Session catalog page did not include the requested host"
    },
    welcome: { suggestions: { whatCanYouDo: "What can you do?" } },
    runControls: {
      newSession: "New session",
      newSessionWorktree: "New session in worktree",
      exportChat: "Export chat",
      queue: "Queue",
      queueMessage: "Queue message",
      stop: "Stop",
      stopWithShortcut: "Stop (Esc)",
      stopGenerating: "Stop generating",
      send: "Send",
      sendMessage: "Send message"
    },
    queue: {
      reviewEdit: "Review edit",
      reloadBlocked: "Save or cancel your queued message edit before reloading.",
      connectionPending: "Finishing connection recovery. Try sending again when it is ready.",
      editSourceChanged: "This queued message changed while you were editing. Your edit is still here. Copy it, cancel the edit, and review the queue before trying again.",
      editStorageFailed: "Your edit could not be saved in this browser. Keep this tab open and copy your edit before freeing browser storage, then try again.",
      full: "The message queue is full. Wait for a queued message to send or remove one, then try again.",
      initialTurnPending: "The initial message is unresolved. Reconnect if needed, then review it before sending another message.",
      notSent: "Not sent",
      deliveryUnconfirmed: "Delivery unconfirmed",
      checkDelivery: "Check delivery",
      checkDeliveryHelp: "Delivery is unconfirmed. Check delivery looks for the original message without resending it or starting a worker. Inspect the conversation, or copy the retained prompt if you choose to start a separate attempt.",
      retry: "Retry",
      retryQueuedMessage: "Retry queued message",
      discard: "Discard",
      discardPendingMessage: "Discard this local pending copy. This does not cancel a message already received by the Gateway.",
      steer: "Steer",
      steerQueuedMessage: "Steer queued message",
      removeQueuedMessage: "Remove queued message",
      reorderQueuedMessage: "Reorder queued message with the arrow keys",
      reorderUnavailable: "This message holds its place and cannot be reordered",
      editQueuedMessage: "Edit queued message",
      moreActions: "More queued message actions",
      cancelEdit: "Cancel editing and keep the queued message",
      states: {
        applyingSettings: "Applying chat settings",
        blockedByUnconfirmed: "Queue paused. Retry or discard the earlier unconfirmed message in the conversation.",
        runningCommand: "Running command",
        waitingForReconnect: "Waiting for reconnect",
        editing: "Editing",
        needsReview: "Delivery uncertain"
      },
      imageCount: "Image ({count})"
    },
    goals: {},
    asyncQuestions: {
      title: "Optional \xB7 work can continue",
      dismiss: "Dismiss",
      dismissing: "Dismissing\u2026",
      dismissed: "Dismissed",
      reopening: "Restoring answer\u2026",
      dismissedReason: "You can still answer this question later.",
      dismissedNotice: "Question dismissed. Work continues.",
      pendingOne: "{count} unanswered question",
      pendingMany: "{count} unanswered questions",
      inComposer: "Answer above the message box.",
      archived: "No longer pending",
      archivedReason: "The conversation moved on. You can still answer this question.",
      sendFailed: "Could not send your answer. Your draft is preserved.",
      queued: "Answer queued",
      sending: "Sending answer\u2026",
      sent: "Answer sent",
      failed: "Answer not sent",
      awaitingConfirmation: "Awaiting delivery confirmation",
      retry: "Retry answer",
      draftStorageFailed: "This answer is not saved on this device. Keep this page open or copy your answer.",
      draftConflict: "This question was edited in another tab. Copy your answer before reloading."
    },
    questions: {
      showSecret: "Show secret",
      hideSecret: "Hide secret",
      resourcePreview: "Preview resource",
      addResources: "Add resources",
      resourceUploadTooLarge: "Selected resources exceed the upload limits.",
      other: "Type your own answer here",
      multilineHint: "Enter adds a line \xB7 {shortcut} to continue",
      answer: "Answer",
      answerPlaceholder: "{label}",
      openLink: "Open link",
      externalStepHint: "Complete the step in the new tab, then return here to submit your answer.",
      submit: "Submit",
      next: "Next",
      back: "Back",
      skip: "Skip",
      skipping: "Skipping\u2026",
      skipped: "Skipped",
      collapse: "Collapse question",
      expand: "Expand question",
      eyebrow: "Waiting for your answer",
      summaryLabel: "Question outcome",
      ownAnswerFor: "Your own answer for {header}",
      storeRequestedBy: "Requested by {agent} \xB7 {session}",
      storeEntry: "Stores {name} as {kind}",
      storeReplacement: "Replaces {name} \u2014 last updated {updated}",
      storeReplacementBy: "Replaces {name} \u2014 last updated {updated} by {updatedBy}",
      submitting: "Submitting\u2026",
      submitFailed: "Could not submit: {error}",
      answered: "Answered",
      answeredElsewhere: "Answered elsewhere",
      unavailable: "Unavailable",
      expired: "Expired",
      disconnected: "Not connected. Try again after reconnecting.",
      loadFailed: "Could not load this question. Try again."
    },
    imageLightbox: {
      loadingDetail: "Loading sharper image\u2026",
      detailFailed: "Preview shown. Sharper image could not load.",
      actions: "Image actions",
      previous: "Previous image",
      next: "Next image",
      position: "{current} / {total}",
      label: "Image preview: {title}",
      open: "Open image {title}",
      openOriginal: "Open in new tab",
      copy: "Copy image",
      download: "Download image",
      copyFailed: "Could not copy this image. Check clipboard access and try again.",
      downloadFailed: "Could not download this image. Try again.",
      loadFailed: "Could not load this image. Try again.",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      resetZoom: "Reset zoom",
      close: "Close image preview",
      untitled: "Image"
    },
    externalImage: { notLoaded: "External image not loaded", open: "Open image" },
    messages: {
      copySelection: "Copy",
      replyingTo: "Replying to {name}",
      message: "message",
      showLess: "Show less",
      showMore: "Show more",
      tooLargeToDisplay: "This message is too large to display here.",
      unattributedSender: "Message",
      toolSender: "Tool",
      errorSender: "Error"
    },
    mediaPlayer: {
      play: "Play",
      pause: "Pause",
      seek: "Seek media",
      mute: "Mute",
      unmute: "Unmute",
      volume: "Volume",
      download: "Download {filename}",
      preparing: "Preparing playback\u2026",
      openVideo: "Expand {filename} in the media overlay",
      videoPreview: "Video preview: {title}",
      closeVideoPreview: "Close video preview"
    },
    youtube: {
      provider: "YouTube",
      video: "YouTube video",
      player: "YouTube player: {title}",
      play: "Play {title}",
      open: "Open on YouTube",
      openVideo: "Open {title} on YouTube",
      close: "Close player",
      strict: "Inline playback is disabled in strict embed mode. Open this video on YouTube.",
      narrow: "Open this video on YouTube to play it in a larger window."
    },
    modelControls: {},
    nativeRuntimeRecovery: {},
    permissionControls: {},
    rail: {
      title: "Side chat",
      subtitle: "Ask about this session or its project",
      expand: "Expand side chat",
      collapse: "Collapse side chat",
      close: "Close side chat",
      show: "Show side chat",
      clear: "Clear side chat",
      pullRequests: "Pull requests",
      checksPassing: "{count} passed",
      checksFailing: "{count} failed",
      checksPending: "{count} running",
      finished: "Finished {time}",
      empty: "Answers come from this session's transcript and its project files.",
      starters: {
        changed: "What changed?",
        stopped: "Why did it stop?",
        remaining: "What's left?"
      },
      askLabel: "Ask in side chat",
      askPlaceholder: "Ask a question",
      askImageQuestion: "What does this image show?",
      selectionTooLong: "These comments are too long for Side chat. Use a shorter selection or comment.",
      selectionQuoteOnly: "The selection is too long to attach. A short quote is ready in Side chat.",
      askSubmit: "Ask",
      askBusy: "Side chat is already answering a question.",
      askHistoryUnavailable: "Couldn't load this session's history.",
      askMissing: "This session is no longer available.",
      askModelUnavailable: "No utility model is configured for this session.",
      askImageUnsupported: "This Side chat model cannot read images. Choose an image-capable utility model, then retry.",
      askRateLimited: "Side chat reached its question limit. Try again shortly.",
      askUnavailable: "Side chat cannot answer right now.",
      askRetry: "Retry",
      asOf: "as of {time}",
      health: {
        "on-track": "On track",
        grinding: "Working",
        stuck: "Stuck",
        "waiting-on-user": "Waiting on you",
        "wrapping-up": "Wrapping up",
        done: "Done",
        failed: "Failed"
      }
    },
    detailPanel: {},
    sidebarColumns: {
      close: "Close {panel}"
    },
    sidePanel: {
      label: "Side panel",
      addTab: "Add side panel tab",
      expand: "Focus",
      expandPanel: "Expand {panel}",
      restore: "Restore split",
      useViewAsDefault: "Use current view as default",
      currentViewIsDefault: "This is the default view",
      defaultViewDescription: "Used when anyone opens this dashboard. Personal layout choices still apply.",
      savingDefault: "Saving default\u2026",
      defaultSaved: "Dashboard default saved for future opens.",
      defaultSaveFailed: "Could not save the dashboard default. Check the connection and try again.",
      defaultSaveError: "Could not save the dashboard default: {error}",
      swap: "Swap {main} and {side}",
      layout: "Layout",
      dockLeft: "Move side panel left",
      dockRight: "Move side panel right",
      dockBottom: "Move side panel below",
      conversation: "Chat",
      showChat: "Show this conversation",
      hideChat: "Hide this conversation",
      conversationEmpty: "The conversation for this task.",
      minimize: "Minimize side panel",
      resize: "Resize side panel",
      review: "Review",
      reviewEmpty: "Open a change, file, image, or tool result to review it here.",
      terminal: "Terminal",
      terminalEmpty: "Open a shell for this session's workspace.",
      browser: "Browser",
      browserEmpty: "A shared browser for you and the agent.",
      files: "Files",
      filesEmpty: "Browse files, artifacts, and changes from this session.",
      companion: "Side chat",
      companionEmpty: "Ask a focused question about this session.",
      processes: "Processes",
      processesEmpty: "Inspect background commands and their output for this conversation.",
      subagents: "Subagents",
      subagentsEmpty: "Follow delegated work from this conversation.",
      desktop: "Desktop",
      desktopEmpty: "Connect to an available remote desktop.",
      portal: "Portal",
      portalEmpty: "Preview a web application running for this task.",
      discussion: "Discussion",
      discussionEmpty: "Open the shared discussion for this session.",
      dashboard: "Dashboard",
      dashboardEmpty: "This task does not have a dashboard yet."
    },
    thread: {
      search: "Search messages",
      searchPlaceholder: "Search messages...",
      closeSearch: "Close search",
      loading: "Loading chat",
      showEarlier: "Show earlier",
      loadingEarlier: "Loading earlier\u2026",
      noMatches: "No matching messages",
      positionRail: "Conversation position",
      positionMarker: "{label}, marker {position} of {count}",
      positionUserMessage: "User message",
      positionAssistantMessage: "Assistant message",
      positionMarkerHint: "Use arrow keys or Home and End to choose a marker, Enter or Space to jump, and Escape to return to the conversation. Tab leaves the rail."
    },
    pendingInputs: {
      agentUpdate: {
        cancelled: "This agent update was cancelled before delivery.",
        interrupted: "Delivery interrupted. This saved agent update is not scheduled to retry."
      },
      waitingForWorkspaceSync: "Received \xB7 waiting for workspace sync",
      waitingForWorkerSetup: "Received \xB7 waiting for worker setup",
      resuming: "Interrupted by a Gateway restart. This saved message will resume when the session is ready.",
      cancelled: "Cancelled before the agent started it. It will not run automatically; copy it and send again.",
      interrupted: "Interrupted before the agent started it. It will not run automatically; copy it and send again.",
      earlier: "Show earlier messages",
      latest: "Show latest messages"
    },
    pairingQrExpired: {
      title: "Pairing QR expired",
      reason: "Run /pair qr again to generate a fresh setup code.",
      badge: "Expired"
    },
    composer: {
      running: "running",
      composerInput: "Chat composer",
      usePrediction: "Use suggestion",
      predictionShortcut: "Tab",
      dismissPrediction: "Dismiss suggestion",
      predictionAvailable: "Suggested message: {text}. Press Tab to use it, or Escape to dismiss. It will not be sent automatically.",
      emojiSuggestions: "Emoji suggestions",
      placeholder: "Message {name}",
      emptyHint: "Write a message to send.",
      placeholderWithAttachments: "Add a message or paste more images...",
      preparingModel: "Preparing model...",
      responding: "{name} is responding...",
      sendingMessage: "Sending message...",
      working: "{name} is working...",
      runDone: "Done",
      runInterrupted: "Interrupted",
      localCancellationCaveat: "Cancellation requested; the local model may still be finishing.",
      runStatus: "Run status: {status}",
      compactingContext: "Compacting context...",
      contextCompacted: "Context compacted",
      fallbackActive: "Fallback active: {model}",
      modelFallbackEvent: "Model fallback: {from} \u2192 {to}",
      modelRestoredEvent: "Returned to selected model: {from} \u2192 {to}",
      fallbackCleared: "Fallback cleared: {model}",
      fallbackSelected: "Selected: {model}",
      fallbackCurrent: "Active: {model}",
      fallbackPrevious: "Previous fallback: {model}",
      fallbackReason: "Reason: {reason}",
      fallbackAttempts: "Attempts: {attempts}",
      cancelReply: "Cancel reply",
      attachmentPreview: "Attachment preview",
      browserAnnotation: "Browser annotation",
      browserAnnotationPreview: "Browser annotation preview",
      browserAnnotationRegion: "{count} marked region",
      browserAnnotationRegions: "{count} marked regions",
      browserAnnotationInspectedElement: "Element inspected",
      browserAnnotationRemoved: "Browser annotation removed.",
      browserAnnotationUndoUnavailable: "Undo is unavailable because the browser annotation limit has been reached.",
      preparingAttachments: "Preparing attachments\u2026",
      preparingAttachmentCount: "Preparing {count} attachment",
      preparingAttachmentsCount: "Preparing {count} attachments",
      removeAttachment: "Remove attachment",
      removeNamedAttachment: "Remove {name}",
      removeBrowserAnnotation: "Remove browser annotation: {name}",
      addAttachment: "Add attachment",
      attach: "Attach\u2026",
      attachPhoto: "Photo",
      attachFileOption: "File",
      menu: {
        back: "Back",
        skills: "Skills",
        connectors: "Connectors",
        webSearch: "Web search",
        webSearchGloballyDisabled: "Web search is disabled in config (tools.web.search.enabled). Session overrides cannot turn it back on.",
        webSearchClearStaleEnable: "Web search is disabled in config. Click to clear this session\u2019s enable override.",
        managePlugins: "Manage plugins",
        manageSkills: "Manage skills",
        addMcpServer: "Add MCP server\u2026",
        addMcpServerTitle: "Add MCP server",
        addMcpServerDescription: "Configure the server and choose where it is enabled.",
        scopeLabel: "Availability",
        scopeSession: "This session",
        scopeEverywhere: "Everywhere",
        scopeSessionHint: "The server is saved globally disabled and enabled only for this session.",
        scopeEverywhereHint: "The server is saved and enabled for every session.",
        toolAccess: {
          label: "Tool access",
          loading: "Loading tools\u2026",
          loadFailed: "Couldn\u2019t load tools.",
          noTools: "No tools available for this connector.",
          summary: "{enabled} of {total} tools on",
          summaryOne: "{enabled} of {total} tool on"
        },
        enabledCount: "{count} on",
        loadingSkills: "Loading skills\u2026",
        skillsLoadFailed: "Couldn\u2019t load skills.",
        noSkills: "No skills available.",
        noConnectors: "No MCP servers configured.",
        depsMissing: "deps missing",
        skillBlocked: "not available for this agent",
        sessionTag: "session",
        offlineBlocked: "Connect to the gateway to change session capabilities.",
        adminBlocked: "Admin access is required to manage connectors.",
        savingBlocked: "Wait for the current session capability change to finish."
      },
      overrides: {
        count: "{count} overrides",
        countOne: "{count} override",
        clear: "Clear session overrides"
      },
      contextUsage: {
        title: "Context usage details",
        open: "Open context usage details",
        summary: "Session context usage: {used} of {limit} ({pct}%)",
        contextWindow: "Context window",
        promptBudget: "Prompt budget",
        latestRunTokens: "Latest run tokens",
        estimatedCost: "Est. cost",
        planUsage: "Plan usage",
        openUsage: "Open usage dashboard",
        resets: "Resets {time}",
        usageCredits: "Usage credits",
        budgetValue: "{used} of {limit}",
        limitFiveHour: "5-hour limit",
        limitWeekly: "Weekly",
        limitDaily: "Daily limit",
        limitHours: "{hours}-hour limit"
      },
      takePhoto: "Take photo",
      cameraAccessFailed: "Unable to access the camera.",
      cameraBusy: "The camera is busy or unavailable to the browser.",
      cameraFallback: "Camera {number}",
      cameraInput: "Camera",
      cameraListUnsupported: "This browser cannot list cameras.",
      cameraNoneFound: "No camera was found.",
      cameraPageInactive: "Cameras are unavailable while this page is inactive.",
      cameraPermissionBlocked: "Camera access is blocked. Allow camera access in browser site settings.",
      cameraPreview: "Camera preview",
      dismissVoiceInputError: "Dismiss voice input error",
      microphoneAccessFailed: "Unable to access microphone inputs.",
      microphoneAccessPending: "Waiting for microphone access. Bring this tab to the foreground and allow access if prompted.",
      microphoneBusy: "Microphone inputs are busy or unavailable to the browser.",
      microphoneStopped: "Microphone input stopped. Choose an available input and start again.",
      microphoneFallback: "Microphone {number}",
      microphoneInput: "Microphone input",
      microphoneAppliesNextSession: "Changes apply when you start your next Talk session.",
      microphoneListUnsupported: "This browser cannot list microphone inputs.",
      noCameras: "No additional cameras found",
      noMicrophones: "No additional microphones found",
      microphoneNoneFound: "No microphone found. Plug one in and it appears here.",
      microphonePageInactive: "Microphone inputs are unavailable while this page is inactive.",
      microphonePermissionBlocked: "Microphone access is blocked. Allow it in browser site settings to list inputs.",
      realtimeTalkCapability: "Tap to talk",
      dictationCapability: "Dictation",
      realtimeTalkProviderUnavailable: "No realtime voice provider is configured.",
      dictationProviderUnavailableShort: "No transcription provider is configured.",
      talkCapabilityChecking: "Checking provider availability\u2026",
      talkCapabilityUnknown: "Provider availability could not be verified.",
      openRealtimeTalkSettings: "Talk settings",
      openDictationSettings: "Transcription setup",
      configureCapability: "Configure",
      holdToRecordSetting: "Hold microphone button to start dictation",
      holdToDictate: "Hold to start dictation",
      holdToRecordSettingDescription: "Hold until dictation starts, then release and keep speaking. Tap Stop to insert the transcript.",
      dictationAudioUnsupported: "The Gateway returned an unsupported dictation audio format.",
      dictationBrowserAudioUnsupported: "This browser cannot capture dictation audio at 8 kHz.",
      dictationDisconnected: "Dictation stopped because the Gateway disconnected.",
      dictationFailed: "Dictation failed.",
      dictationInterruptedRecovery: "Captured text was inserted. Check your connection and try again.",
      dictationStartRecovery: "Check microphone access and transcription settings, then try again.",
      dictationFinalizing: "Finishing dictation\u2026",
      dictationListening: "Listening\u2026",
      dictationStopAndKeep: "Stop and keep text",
      dictationProviderUnavailable: "No transcription provider is configured for dictation. Choose one in Settings to dictate.",
      realtimeTalkCancellationRejected: "Realtime output cancellation was not accepted.",
      realtimeTalkMissingTurnIdentity: "Realtime output is missing its turn identity.",
      realtimeTalkRelayUnresponsive: "Talk ended because the Gateway has not acknowledged microphone audio for 30 seconds. Check the connection and start Talk again.",
      realtimeTalkRequiresMicrophone: "Realtime voice input requires browser microphone access.",
      selectedMicrophoneUnavailable: "The selected microphone is unavailable. Choose another input or System default.",
      selectedCameraUnavailable: "The selected camera is unavailable. Choose another camera or System default.",
      startVoiceInput: "Start voice input",
      voiceGestureHint: "Tap to talk \xB7 Hold to start dictation",
      stillListening: "Still listening",
      stopVoiceInput: "Stop voice input",
      systemDefaultMicrophone: "System default",
      useSystemDefaultMicrophoneForCall: "Use System default for this call",
      systemDefaultCamera: "System default",
      switchCamera: "Switch camera",
      turnCameraOff: "Turn camera off",
      turnCameraOn: "Turn camera on",
      voiceTranscript: "Voice transcript"
    },
    attachments: {
      allowImage: "Allow image",
      attachedFile: "Attached file",
      audio: "Audio",
      download: "Download",
      expand: "Open {filename} in the side panel",
      open: "Open",
      previewUnavailable: "Preview unavailable",
      textPreviewUnavailable: "Could not preview this file. Text previews require UTF-8 files up to 256 KiB. Download it to read the full file.",
      htmlPreviewUnavailable: "Could not preview this HTML file. HTML previews require UTF-8 files up to 2 MiB. Download it to read the full file.",
      readFailed: "Could not attach: {names}{more}",
      imagesOnly: "Side chat accepts image attachments only.",
      tooLarge: "Too large to send: {names}{more}",
      openOriginal: "Open original",
      retryHelp: "Choose a smaller file, remove other attachments, or try attaching it again.",
      compressToFit: "Compress to fit",
      compressionHint: "Video is too large. Compress a copy on this device; the original stays unchanged.",
      compressing: "Compressing\u2026 {progress}%",
      compressionUnsupported: "This browser cannot compress this video with its audio. Try another browser or a smaller file.",
      compressionTooLarge: "This video could not fit. Trim it or choose a smaller file.",
      compressionFailed: "Could not compress this video. Try again or choose a smaller file.",
      showInTextField: "Show in text field",
      pastedText: "Pasted text",
      outsideAllowedFolders: "Outside allowed folders",
      unavailable: "Unavailable",
      failureDeliveryFailed: "Delivery failed. Try sending this file again.",
      failureInvalidReference: "Use a public HTTPS URL without credentials or attach a local file by a safe path.",
      failureFileNotFound: "File not found. Check the path and try again.",
      failureUnsupportedFormat: "Rejected by the local attachment allowlist. Send a supported file type.",
      history: "History",
      image: "Image",
      notSent: "Not sent",
      omittedFromHistory: "Omitted from history",
      omittedFromHistoryWithSize: "Omitted from history \xB7 {size}",
      video: "Video"
    },
    voice: {
      asking: "Asking OpenClaw...",
      replyFailed: "The voice reply was interrupted. Start Talk again to retry.",
      replyTimedOut: "Talk stopped waiting. The agent's answer will appear in chat when it finishes.",
      preparing: "Preparing voice session...",
      connecting: "Connecting voice input...",
      listening: "Listening...",
      selectionFailed: "Could not change voices. Restart the call.",
      selectionTimedOut: "Voice change timed out. Restart the call.",
      selectionConfirmationFailed: "Voice change unconfirmed."
    },
    selectors: {
      loadMoreSessions: "Show more",
      loadMoreRosterSessions: "Load more sessions",
      model: "Chat model",
      modelSection: "Model",
      modelLocked: "Locked",
      modelLockedLabel: "Model selection controlled for this session",
      lockedSessionModel: "Session model",
      thinkingLevel: "Chat thinking level"
    },
    permissions: {
      title: "Grant {permissions}",
      neededOn: "OpenClaw needs access on {node} to continue this action.",
      openApp: "Grant access in the OpenClaw Mac app on that device: Settings \u2192 This Mac \u2192 Permissions. Then tell the agent to try again.",
      ready: "Access is available. You can ask the agent to try again.",
      following: "Then grant the remaining permissions: {permissions}.",
      actions: {
        "not-determined": "Grant {permissions}",
        denied: "Open System Settings",
        "restart-required": "Relaunch OpenClaw",
        "stale-grant": "Open System Settings",
        "disabled-in-openclaw": "Enable {permissions}"
      },
      tryAgain: "Try again",
      retryMessage: "I granted {permissions}, try again.",
      states: {
        "not-determined": "Choose Grant to review the permission request.",
        denied: "Open System Settings to allow access for OpenClaw.",
        "restart-required": "If you enabled access in System Settings, relaunch OpenClaw to make it available.",
        "stale-grant": "macOS may be using a stale permission grant. Open System Settings to review it.",
        "disabled-in-openclaw": "Choose Enable to review and enable this capability in OpenClaw."
      },
      capabilities: {
        notifications: "Notifications",
        accessibility: "Accessibility",
        eventPosting: "Event Posting",
        screenRecording: "Screen Recording",
        microphone: "Microphone",
        speechRecognition: "Speech Recognition",
        camera: "Camera",
        cameraEnabled: "Camera in OpenClaw",
        location: "Location",
        computerControl: "Computer Control",
        canvas: "Canvas",
        automation: "Automation"
      }
    },
    toolCards: {
      tool: "Tool",
      canvas: "Canvas",
      summary: "Summary",
      toolInput: "Tool input",
      toolOutput: "Tool output",
      providerResponse: "Provider tool response",
      executionOutput: "Execution output",
      showFullOutput: "Show full output",
      fullOutputUnavailable: "Full output unavailable. Only the captured output is shown.",
      copyOutput: "Copy available output",
      downloadOutput: "Download available output",
      outputLoadFailed: "Could not load the full output. Try again.",
      outputDownloadFailed: "Could not download the output. Try again.",
      toolError: "Tool error",
      rawDetails: "Raw details",
      activity: {
        titleOne: "1 operation",
        titleMany: "{count} operations",
        commandsOne: "1 command",
        commandsMany: "{count} commands",
        readsOne: "1 read",
        readsMany: "{count} reads",
        editsOne: "1 edit",
        editsMany: "{count} edits",
        writesOne: "1 write",
        writesMany: "{count} writes",
        searchesOne: "1 search",
        searchesMany: "{count} searches",
        fetchesOne: "1 fetch",
        fetchesMany: "{count} fetches",
        otherOne: "1 other operation",
        otherMany: "{count} other operations",
        subagentsOne: "1 subagent",
        subagentsMany: "{count} subagents",
        failed: "{count} failed",
        blocked: "{count} blocked",
        unknown: "{count} unknown"
      },
      showRawDetails: "Show raw details",
      hideRawDetails: "Hide raw details",
      viewMode: "Tool detail view",
      diff: "Diff",
      raw: "Raw",
      openFile: "Open file",
      openDetails: "Open tool details in side panel",
      widgetActions: "Widget actions",
      copyToClipboard: "Copy to clipboard",
      downloadFile: "Download file",
      copyAsImage: "Copy as image",
      downloadAsImage: "Download as image",
      widgetExportRerender: "This widget needs to be re-rendered to export as an image.",
      widgetExportHtmlFallback: "Image unavailable. Downloaded the widget as HTML instead.",
      widgetExportFailed: "Widget export failed. Try again.",
      pinToDashboard: "Pin to dashboard",
      pinToDashboardPending: "Pinning\u2026",
      pinToDashboardFailed: "Could not pin to dashboard. Try again.",
      pinnedToDashboard: "Pinned",
      fileChanges: "File changes",
      attemptedChanges: "Attempted changes",
      failed: "failed",
      skipped: "Skipped",
      skippedCount: "{count} skipped",
      running: "Running",
      subagentRunning: "running",
      subagentStopped: "stopped",
      openSubagent: "Open subagent session",
      completed: "Completed",
      blocked: "Blocked",
      outcomeUnknown: "Outcome unknown",
      exitCode: "Exit code {code}",
      failureCount: "{count} failed",
      noOutputFailed: "No output \u2014 tool failed.",
      noOutputSucceeded: "No output \u2014 tool completed successfully.",
      noResult: "No result available.",
      review: {
        reviewing: "{reviewer} reviewing",
        approved: "{reviewer} approved",
        denied: "{reviewer} denied",
        timedOut: "{reviewer} timed out",
        aborted: "{reviewer} stopped",
        risk: "{level} risk",
        authorization: "{level} authorization",
        noRationale: "No rationale was provided."
      },
      verbs: {
        read: "Read",
        edit: "Edit",
        editing: "Editing",
        edited: "Edited",
        create: "Create",
        creating: "Creating",
        created: "Created",
        delete: "Delete",
        deleting: "Deleting",
        deleted: "Deleted",
        change: "Change",
        changing: "Changing",
        changed: "Changed",
        write: "Write",
        writing: "Writing",
        wrote: "Wrote",
        searched: "Searched",
        fetched: "Fetched"
      }
    },
    workRun: {
      workedFor: "Worked for {duration}",
      worked: "Worked",
      toolCallsOne: "1 tool call",
      toolCallsMany: "{count} tool calls"
    },
    sessionDiff: {
      title: "Changes",
      show: "Show session changes",
      refresh: "Refresh changes",
      loading: "Loading changes\u2026",
      empty: "No changes in this session's checkout.",
      notGit: "This session's workspace is not a git checkout.",
      unknownSession: "No workspace is associated with this session.",
      unknownCommit: "This commit is no longer available in the session checkout.",
      workspaceStopped: "Saved changed files are shown. Start the cloud session to load full diffs and line counts.",
      workspaceStoppedFile: "Start the cloud session to load this diff.",
      disconnected: "Gateway is disconnected.",
      allChanges: "All Changes",
      uncommitted: "Uncommitted",
      commitsAhead: "{count} commits ahead of {base}",
      head: "HEAD",
      mergeBase: "Merge Base",
      scopeMenu: "Choose change scope",
      sync: "Sync",
      syncLocally: "Sync Locally",
      syncDescription: "Run this command in a local checkout to mirror this session's committed changes.",
      copyCommand: "Copy sync command",
      checkoutPath: "Checkout path",
      branchName: "Branch name",
      uncommittedStay: "Uncommitted changes stay in the session checkout.",
      viewOptions: "Change view options",
      collapseCode: "Collapse Code",
      collapseFunctions: "Collapse Functions and Classes",
      expandCode: "Expand Code",
      collapseCodeRegion: "Collapse code at line {line}",
      expandCodeRegion: "Expand code at line {line}",
      foldedLines: "{count} folded lines",
      collapseAll: "Collapse All",
      expandAll: "Expand All",
      enableWrapping: "Enable Wrapping",
      disableWrapping: "Disable Wrapping",
      switchSplit: "Switch to Split Diff",
      switchUnified: "Switch to Unified Diff",
      fileActions: "Actions for {path}",
      copyPath: "Copy Path",
      openFile: "Open File",
      openInEditor: "Open in Editor",
      revealInFileTree: "Reveal in File Tree",
      unmodifiedLines: "{count} unmodified lines",
      expandPreviousLines: "Show previous {count} unmodified lines",
      expandNextLines: "Show next {count} unmodified lines",
      expandAllLines: "Show all {count} unmodified lines",
      binaryFile: "Binary file",
      untracked: "untracked",
      previewUnavailable: "Diff preview is unavailable.",
      truncatedFile: "Diff truncated.",
      truncatedResult: "Some changes could not be displayed.",
      statusAdded: "Added",
      statusDeleted: "Deleted",
      statusRenamed: "Renamed",
      statusModified: "Modified"
    },
    sessionDiscussion: {
      show: "Show discussion",
      hide: "Hide discussion",
      disconnected: "Gateway is disconnected.",
      loading: "Loading discussion\u2026",
      opening: "Opening discussion\u2026",
      requiresWriteAccess: "Operator write access is required to open this discussion.",
      openExternal: "Open discussion in a new tab",
      frameTitle: "Session discussion",
      unavailable: "This discussion cannot be embedded."
    },
    workspaceFiles: {
      label: "Session workspace",
      collapse: "Collapse session workspace",
      showFiles: "Show session files",
      dockRight: "Dock to the right",
      dockBottom: "Dock to the bottom",
      workspace: "Session",
      files: "Workspace",
      refresh: "Refresh session workspace",
      loading: "Loading session workspace\u2026",
      changed: "Changed",
      read: "Read",
      artifacts: "Artifacts",
      browser: "Project files",
      root: "Root",
      search: "Search files",
      searchResults: "Search results",
      parentFolder: "Parent folder",
      noBrowserFiles: "No files in this folder.",
      folderUnavailable: "This folder is unavailable. Open its parent folder to continue browsing.",
      noSearchResults: "No matching files.",
      truncated: "Showing the first matching files. Refine the search to narrow results.",
      session: "Session",
      missing: "Missing",
      filterAll: "All",
      filters: "Filter files",
      changedCount: "{count} changed",
      readCount: "{count} read",
      artifactCount: "{count} artifacts",
      actions: "Workspace file actions",
      preview: "Preview",
      copyPath: "Copy path"
    }
  },
  languages: {
    en: "English",
    zhCN: "\u7B80\u4F53\u4E2D\u6587 (Simplified Chinese)",
    zhTW: "\u7E41\u9AD4\u4E2D\u6587 (Traditional Chinese)",
    ptBR: "Portugu\xEAs (Brazilian Portuguese)",
    de: "Deutsch (German)",
    es: "Espa\xF1ol (Spanish)",
    jaJP: "\u65E5\u672C\u8A9E (Japanese)",
    ko: "\uD55C\uAD6D\uC5B4 (Korean)",
    fr: "Fran\xE7ais (French)",
    hi: "\u0939\u093F\u0928\u094D\u0926\u0940 (Hindi)",
    ar: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 (Arabic)",
    it: "Italiano (Italian)",
    tr: "T\xFCrk\xE7e (Turkish)",
    uk: "\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430 (Ukrainian)",
    id: "Bahasa Indonesia (Indonesian)",
    pl: "Polski (Polish)",
    th: "\u0E44\u0E17\u0E22 (Thai)",
    vi: "Ti\u1EBFng Vi\u1EC7t (Vietnamese)",
    nl: "Nederlands (Dutch)",
    fa: "\u0641\u0627\u0631\u0633\u06CC (Persian)",
    ru: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 (Russian)",
    sv: "Svenska (Swedish)"
  },
  secretsStore: {
    name: "Name",
    access: "Access",
    accessMode: "Access mode",
    value: "Value",
    allowedHosts: "Allowed hosts",
    allowedHostsPlaceholder: "api.example.com",
    allowedHostsHint: "Exact hostnames only, one per line or comma-separated. No wildcards or ports.",
    noAllowedHosts: "None",
    updated: "Last updated",
    by: "{time} by {name}",
    actions: "Actions",
    add: "Add",
    edit: "Edit",
    bulk: "Bulk Add",
    protectedSecret: "Protected secret",
    protectedSecretHint: "Hidden after save and inert unless referenced by a SecretRef or used through enabled destination-bound Gateway egress. It is never directly readable.",
    agentReadable: "Agent-readable environment",
    agentReadableHint: "High risk: visible to admins and plaintext to Gateway-hosted agent commands. The agent can print, transmit, or persist it. Applies from the next run.",
    hint: "Choose protected, write-only secrets or intentionally agent-readable Gateway environment values.",
    required: "Enter a value.",
    detect: "Protect credential-like names automatically",
    detected: "{count} protected secrets detected",
    detectedOne: "{count} protected secret detected",
    unavail: "Gateway/admin required.",
    badName: "Use SERVICE_API_KEY.",
    tooLarge: "Max 64 KiB.",
    savedProtected: "Saved {name} as Protected secret. Add a SecretRef or enable destination-bound Gateway egress to use it.",
    savedReadable: "Saved {name} as Agent-readable environment. It is available to Gateway-hosted agent commands from the next run.",
    savedMany: "Saved {count} entries ({protected} protected, {readable} agent-readable). Protected secrets need a SecretRef or enabled destination-bound Gateway egress; agent-readable environment values reach Gateway-hosted agent commands from the next run.",
    warnings: "{count} runtime warnings.",
    partial: "{saved}/{total}: {error}",
    confirmDelete: "Delete {name}?",
    deleted: "Deleted {name}.",
    deleteFailed: "The secret was not deleted. Reload the list and try again."
  },
  cron: {
    adminRequired: "Browsing only. Automation changes require operator.admin access.",
    tabs: {},
    list: {},
    suggestions: {},
    stats: {},
    detail: {},
    actions: {},
    // Shared cron actions report outcomes before the automation page loads.
    runNotStarted: {
      notDue: "This automation is not due yet.",
      alreadyRunning: "This automation is already running.",
      recoveryPending: "Scheduler recovery is still in progress.",
      invalidSpec: "This automation has an invalid schedule or payload.",
      stopped: "The scheduler is stopped.",
      unknown: "This automation could not be started."
    },
    jobs: {},
    runs: {},
    form: {},
    jobState: {},
    runEntry: {},
    errors: {
      nameRequired: "Name is required.",
      scheduleAtInvalid: "Enter a valid date/time.",
      everyAmountInvalid: "Interval must be greater than 0.",
      triggerIntervalTooShort: "Condition-triggered automations must run at least every 30 seconds.",
      cronExprRequired: "Cron expression is required.",
      staggerAmountInvalid: "Stagger must be greater than 0.",
      triggerScriptRequired: "Trigger script is required when the condition trigger is enabled.",
      triggerScriptPayloadUnsupported: "Script payloads cannot use condition triggers because both own the same saved state.",
      triggerScheduleUnsupported: "Condition triggers require an interval, cron, or stream schedule.",
      systemTextRequired: "System text is required.",
      agentMessageRequired: "Agent message is required.",
      timeoutInvalid: "If set, timeout must be 0 or greater (0 disables this timeout).",
      deliveryModeRequired: "Choose a delivery mode explicitly, or run openclaw doctor --fix to repair legacy settings.",
      webhookUrlRequired: "Webhook URL is required.",
      webhookUrlInvalid: "Webhook URL must be a valid http(s):// URL without embedded credentials.",
      invalidRunTime: "Invalid run time.",
      invalidIntervalAmount: "Invalid interval amount.",
      cronExprRequiredShort: "Cron expression required.",
      invalidStaggerAmount: "Invalid stagger amount.",
      systemEventTextRequired: "System event text required.",
      agentMessageRequiredShort: "Agent message required.",
      nameRequiredShort: "Name required."
    }
  },
  linkReader: {
    loadingPreview: "Loading preview\u2026",
    title: "Link reader",
    urlPlaceholder: "Supported link URL"
  }
};

// openclaw/ui/src/api/gateway-connect-plan.ts
mn();

// openclaw/ui/src/i18n/locales/en-browser.ts
var Lo = {
  browser: {
    unavailable: "Browser control is unavailable for this connection. Reconnect with browser access.",
    navigationBlocked: "The current browser navigation rules block this address. Select another tab or enter an allowed address.",
    navigationCheckFailed: "OpenClaw couldn\u2019t verify this tab\u2019s address. Refresh to try again.",
    tabUnavailable: "This tab is no longer available. Select another tab.",
    noChatTarget: "Open a chat session first so the annotation has somewhere to go.",
    annotationLimitReached: "Remove a browser annotation before retrying (maximum 4 cards and 8,000 characters of generated context).",
    inspectUnavailable: "Element inspection is disabled (browser.evaluateEnabled=false).",
    annotationSent: "Annotation added to the chat composer.",
    dashboardSessionShared: "You and your agent share this isolated session browser",
    dashboardShared: "You and your agent share this browser page",
    dashboardStopped: "This dashboard's browser is stopped.",
    dashboardStopping: "Browser stop is pending. Retry to finish closing its tab.",
    dashboardStop: "Stop browser",
    dashboardRetryStop: "Retry stop",
    dashboardResume: "Resume browser",
    dashboardReconnect: "Reconnect",
    dashboardUnavailable: "Connect to a Gateway with browser access to use this dashboard.",
    dashboardMissingIdentity: "Save this dashboard widget again before opening its browser.",
    dashboardInvalidReply: "The browser response does not match this dashboard. Reconnect and try again.",
    downloading: "Downloading\u2026",
    downloadFile: "Download file",
    inputLabel: "Browser input: click a field in the page, then type or paste",
    manualTextCorrection: "Autocorrect is unavailable in browser control. Edit the text directly.",
    errors: {
      pasteFailed: "Could not paste. Reconnect to a managed browser and try again.",
      requestFailed: "Browser request failed: {error}",
      downloadFailed: "Could not download this file: {error}. Try again, or open it in your browser to save it.",
      downloadEmpty: "No file returned.",
      screenshotPathMissing: "Browser screenshot did not return a media path.",
      screenshotFetchTimedOut: "Screenshot fetch timed out.",
      screenshotFetchFailed: "Screenshot fetch failed ({status}).",
      screenshotReadFailed: "Screenshot read failed.",
      screenshotDecodeFailed: "Screenshot decode failed.",
      canvasUnavailable: "Canvas 2D context unavailable."
    },
    annotatePrompt: {
      browserTarget: "Browser target: {target}",
      // introTitled/elementDetail (not intro/element): translated keys never
      // retranslate on source-wording changes, so the provenance-label rewrite
      // required fresh key names to propagate to all locales.
      introTitled: 'I annotated the page at {url} (page-reported title: "{title}") \u2014 the attached screenshot shows my markup.',
      introUntitled: "I annotated the page at {url} \u2014 the attached screenshot shows my markup.",
      region: "Marked region {index}: centered around {x}% across / {y}% down, spanning about {width}% \xD7 {height}% of the view.",
      moreRegions: "\u2026plus {count} more marked region(s), all visible in the screenshot.",
      elementDetail: "Marked element (page-reported): {descriptor} \u2014 {width}\xD7{height}px at ({x}, {y}).",
      outro: "Please look at the marked area and tell me what you make of it."
    }
  }
}, Bo = Object.assign(
  () => {
    let { errors: e, annotatePrompt: t, ...n } = Lo.browser;
    Object.assign(Ke.browser, n), Object.assign(Ke.browser.errors, e), Object.assign(Ke.browser.annotatePrompt, t);
  },
  { catalog: Lo }
);

// openclaw/ui/src/components/browser/browser-inspect-script.ts
var gc = String.raw`function openclawInspectBrowserElement(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  const nameSource = label || text;
  const nameLimit = 120;
  // This serialized page function cannot call imported helpers; back up only when the cap splits a surrogate pair.
  const nameEnd = (nameSource.codePointAt(nameLimit - 1) || 0) > 0xffff ? nameLimit - 1 : nameLimit;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    classes: Array.from(el.classList).slice(0, 6),
    role: el.getAttribute("role") || "",
    name: nameSource.slice(0, nameEnd),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    focusable: typeof el.tabIndex === "number" && el.tabIndex >= 0,
  };
}`;

// openclaw/ui/src/components/browser/browser-target.ts
D();
function wn(e, t = 128) {
  return typeof e == "string" && e.length > 0 && e.length <= t && e.trim() === e;
}
function bn(e) {
  let t = L(e);
  if (!wn(t?.targetId) || !wn(t.profile))
    return;
  let n = { targetId: t.targetId, profile: t.profile };
  if (t.target === "host" && t.node === void 0)
    return { ...n, target: "host" };
  if (t.target === "node" && wn(t.node, 256))
    return { ...n, target: "node", node: t.node };
}
function Go(e) {
  return JSON.stringify([e.target, e.node, e.profile, e.targetId]);
}

// openclaw/ui/src/components/browser/browser-client.ts
Bo();

// openclaw/ui/src/lib/chat/tool-cards.ts
Rr();

// openclaw/packages/net-policy/src/url-protocol.ts
function yc(e) {
  return e instanceof URL ? e : URL.parse(e);
}
function Ho(e) {
  let t = yc(e);
  return t?.protocol === "http:" || t?.protocol === "https:";
}

// openclaw/ui/src/lib/chat/tool-cards.ts
Y();
D();
F();
Pe();

// openclaw/src/agents/tool-display-call.ts
D();

// openclaw/src/chat/canvas-render.ts
Y();
oe();
D();
F();

// openclaw/src/shared/text/code-regions.ts
Y();

// openclaw/packages/markdown-core/src/reasoning-tag-parser.ts
Y();
var zo = [
  "think",
  "thinking",
  "thought",
  "reasoning",
  "internal",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "antml:reasoning",
  "mm:think",
  "mm:thinking",
  "mm:thought",
  "mm:reasoning"
], ty = new Set(zo);

// openclaw/src/chat/canvas-render.ts
function bc(e) {
  let t = O(e?.viewId);
  if (!t || t.length > 128)
    return;
  let n = O(e?.serverName), o = O(e?.toolName), r = O(e?.uiResourceUri), i = O(e?.toolCallId), s = O(e?.originSessionKey), a = e?.resultMetaState === "unavailable" ? "unavailable" : void 0;
  return !!(n && n.length <= 256 && o && o.length <= 256 && r?.startsWith("ui://") && r.length <= 2048 && i && i.length <= 512) ? {
    viewId: t,
    serverName: n,
    toolName: o,
    uiResourceUri: r,
    toolCallId: i,
    ...s && s.length <= 512 ? { originSessionKey: s } : {},
    ...a ? { resultMetaState: a } : {}
  } : { viewId: t };
}
function Sc(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 160 ? Math.min(Math.trunc(e), 1200) : void 0;
}
function jo(e) {
  return typeof e == "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(e);
}
function $o(e) {
  if (!e || O(e?.kind)?.trim().toLowerCase() !== "canvas")
    return;
  let n = G(e.presentation), o = G(e.view), r = G(e.source), i = bc(G(e.mcpApp)), s = i?.viewId, l = O(n?.target) ?? O(e?.target) ?? "assistant_message";
  if (l !== "assistant_message" && l !== "node_panel")
    return;
  let u = O(n?.title) ?? O(o?.title), h = Sc(
    re(n?.preferred_height) ?? re(n?.preferredHeight) ?? re(o?.preferred_height) ?? re(o?.preferredHeight)
  ), p = O(n?.class_name) ?? O(n?.className), g = O(n?.style), c = O(n?.sandbox), d = O(o?.url) ?? O(o?.entryUrl), m = O(o?.id) ?? O(o?.docId), f = O(o?.boardWidgetName), y = jo(f) ? f : void 0, w = {
    kind: "canvas",
    surface: l,
    render: "url",
    ...u ? { title: u } : {},
    ...h ? { preferredHeight: h } : {},
    ...c === "strict" || c === "scripts" ? { sandbox: c } : {},
    ...i ? { mcpApp: i } : {}
  };
  if (s && m === s)
    return { ...w, viewId: m };
  let b = d ?? (O(r?.type)?.trim().toLowerCase() === "url" ? O(r?.url) : void 0);
  if (b)
    return {
      ...w,
      url: b,
      ...d && m ? { viewId: m } : {},
      ...p ? { className: p } : {},
      ...g ? { style: g } : {},
      ...d && y ? { boardWidgetName: y } : {}
    };
}
function Ko(e) {
  let t = G(e);
  return $o(G(t?.mcpAppPreview));
}
function Vo(e) {
  let t = e ? be(e) : void 0;
  return $o(t);
}

// openclaw/src/chat/tool-content.ts
rn();
F();
var kc = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId"
];
function Yo(e) {
  return typeof e == "string" ? e.toLowerCase() : "";
}
function Sn(e) {
  let t = Yo(e);
  return t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use";
}
function Ct(e) {
  let t = Yo(e);
  return t === "toolresult" || t === "tool_result";
}
function Zo(e) {
  for (let t of kc) {
    let n = W(e[t]);
    if (n)
      return n;
  }
}
function Tt(e) {
  let t = e.isError ?? e.is_error;
  return typeof t == "boolean" ? t : void 0;
}
var Rc = /^tool not found\.?$/i, xc = 2e4, vc = /* @__PURE__ */ new Set(["error", "failed", "timeout"]);
function Cc(e) {
  return typeof e == "string" && vc.has(e.trim().toLowerCase());
}
function Jo(e) {
  let t = e?.trim();
  if (!t)
    return !1;
  if (Rc.test(t))
    return !0;
  if (t.length > xc || !t.startsWith("{") || !t.endsWith("}"))
    return !1;
  let n = be(t);
  if (!n)
    return !1;
  let o = Tt(n);
  if (o !== void 0)
    return o;
  if ("error" in n) {
    let r = n.error;
    if (typeof r == "string")
      return r.trim().length > 0;
    if (typeof r == "boolean")
      return r;
    if (r && typeof r == "object")
      return !0;
  }
  return Cc(n.status);
}

// openclaw/ui/src/lib/chat/message-normalizer.ts
oe();
D();
F();

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
Y();
D();

// openclaw/src/shared/regexp.ts
function Te(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// openclaw/src/plugin-sdk/message-tool-delivery-hints.ts
var Tc = "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.", Ec = "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.", Et = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  Tc,
  Ec
];

// openclaw/src/auto-reply/reply/inbound-context-marker.ts
var At = "\u27E6openclaw:ctx\u27E7";

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
var Uy = `Context: ${At}`, Ac = "Context:";
var Fy = [
  "[",
  At,
  ...Et,
  Ac
], Ly = new RegExp(
  [At, ...Et].map(Te).join("|"),
  "g"
);

// openclaw/packages/llm-core/src/types.ts
var Xo = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", Qo = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", ei = "OpenClaw runtime context:", ti = "End OpenClaw runtime context.";

// openclaw/packages/agent-core/src/harness/messages.ts
oe();
D();

// openclaw/packages/agent-core/src/operator-messages.ts
D();

// openclaw/src/agents/internal-runtime-context.ts
var Pc = Xo, Dc = Qo;
var ni = "This context is runtime-generated, not user-authored. Keep internal details private.";
var dw = ["OpenClaw runtime context (internal):", ni, ""].join(`
`) + `
`;
function _t(e) {
  return {
    token: e,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${Te(e)}[ \\t]*(?=\\r?\\n|$)`, "g")
  };
}
var uw = _t(Pc), pw = _t(Dc), fw = _t(ei), hw = _t(ti);
var Mc = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event."
], Oc = new RegExp(
  Mc.flatMap((e) => {
    let t = e.split(". ");
    return t.map((n, o) => t.slice(o).join(". "));
  }).map((e) => e.split(/\s+/).map(Te).join("\\s+")).join("|")
), Nc = new RegExp(
  ni.split(/\s+/).map(Te).join("\\s+")
), gw = new RegExp(
  `^[ \\t]*(?:${Oc.source})\\s+${Nc.source}[ \\t]*(?:\\r?\\n|$)`,
  "gm"
);

// openclaw/src/chat/message-client-source.ts
D();
F();
Pe();

// openclaw/src/chat/work-context.ts
D();
Pe();

// openclaw/packages/markdown-core/src/image-spans.ts
Y();

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/index.mjs
var kn = {};
Ht(kn, {
  decode: () => Ve,
  encode: () => ue,
  format: () => Fe,
  parse: () => Ye
});

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/decode.mjs
var ri = {};
function Fc(e) {
  let t = ri[e];
  if (t)
    return t;
  t = ri[e] = [];
  for (let n = 0; n < 128; n++) {
    let o = String.fromCharCode(n);
    t.push(o);
  }
  for (let n = 0; n < e.length; n++) {
    let o = e.charCodeAt(n);
    t[o] = "%" + ("0" + o.toString(16).toUpperCase()).slice(-2);
  }
  return t;
}
function It(e, t) {
  typeof t != "string" && (t = It.defaultChars);
  let n = Fc(t);
  return e.replace(/(%[a-f0-9]{2})+/gi, function(o) {
    let r = "";
    for (let i = 0, s = o.length; i < s; i += 3) {
      let a = parseInt(o.slice(i + 1, i + 3), 16);
      if (a < 128) {
        r += n[a];
        continue;
      }
      if ((a & 224) === 192 && i + 3 < s) {
        let l = parseInt(o.slice(i + 4, i + 6), 16);
        if ((l & 192) === 128) {
          let u = a << 6 & 1984 | l & 63;
          u < 128 ? r += "\uFFFD\uFFFD" : r += String.fromCharCode(u), i += 3;
          continue;
        }
      }
      if ((a & 240) === 224 && i + 6 < s) {
        let l = parseInt(o.slice(i + 4, i + 6), 16), u = parseInt(o.slice(i + 7, i + 9), 16);
        if ((l & 192) === 128 && (u & 192) === 128) {
          let h = a << 12 & 61440 | l << 6 & 4032 | u & 63;
          h < 2048 || h >= 55296 && h <= 57343 ? r += "\uFFFD\uFFFD\uFFFD" : r += String.fromCharCode(h), i += 6;
          continue;
        }
      }
      if ((a & 248) === 240 && i + 9 < s) {
        let l = parseInt(o.slice(i + 4, i + 6), 16), u = parseInt(o.slice(i + 7, i + 9), 16), h = parseInt(o.slice(i + 10, i + 12), 16);
        if ((l & 192) === 128 && (u & 192) === 128 && (h & 192) === 128) {
          let p = a << 18 & 1835008 | l << 12 & 258048 | u << 6 & 4032 | h & 63;
          p < 65536 || p > 1114111 ? r += "\uFFFD\uFFFD\uFFFD\uFFFD" : (p -= 65536, r += String.fromCharCode(55296 + (p >> 10), 56320 + (p & 1023))), i += 9;
          continue;
        }
      }
      r += "\uFFFD";
    }
    return r;
  });
}
It.defaultChars = ";/?:@&=+$,#";
It.componentChars = "";
var Ve = It;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/encode.mjs
var oi = {};
function Lc(e) {
  let t = oi[e];
  if (t)
    return t;
  t = oi[e] = [];
  for (let n = 0; n < 128; n++) {
    let o = String.fromCharCode(n);
    /^[0-9a-z]$/i.test(o) ? t.push(o) : t.push("%" + ("0" + n.toString(16).toUpperCase()).slice(-2));
  }
  for (let n = 0; n < e.length; n++)
    t[e.charCodeAt(n)] = e[n];
  return t;
}
function Pt(e, t, n) {
  typeof t != "string" && (n = t, t = Pt.defaultChars), typeof n > "u" && (n = !0);
  let o = Lc(t), r = "";
  for (let i = 0, s = e.length; i < s; i++) {
    let a = e.charCodeAt(i);
    if (n && a === 37 && i + 2 < s && /^[0-9a-f]{2}$/i.test(e.slice(i + 1, i + 3))) {
      r += e.slice(i, i + 3), i += 2;
      continue;
    }
    if (a < 128) {
      r += o[a];
      continue;
    }
    if (a >= 55296 && a <= 57343) {
      if (a >= 55296 && a <= 56319 && i + 1 < s) {
        let l = e.charCodeAt(i + 1);
        if (l >= 56320 && l <= 57343) {
          r += encodeURIComponent(e[i] + e[i + 1]), i++;
          continue;
        }
      }
      r += "%EF%BF%BD";
      continue;
    }
    r += encodeURIComponent(e[i]);
  }
  return r;
}
Pt.defaultChars = ";/?:@&=+$,-_.!~*'()#";
Pt.componentChars = "-_.!~*'()";
var ue = Pt;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/format.mjs
function Fe(e) {
  let t = "";
  return t += e.protocol || "", t += e.slashes ? "//" : "", t += e.auth ? e.auth + "@" : "", e.hostname && e.hostname.indexOf(":") !== -1 ? t += "[" + e.hostname + "]" : t += e.hostname || "", t += e.port ? ":" + e.port : "", t += e.pathname || "", t += e.search || "", t += e.hash || "", t;
}

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/parse.mjs
function Dt() {
  this.protocol = null, this.slashes = null, this.auth = null, this.port = null, this.hostname = null, this.hash = null, this.search = null, this.pathname = null;
}
var Bc = /^([a-z0-9.+-]+:)/i, Gc = /:[0-9]*$/, Hc = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/, zc = ["<", ">", '"', "`", " ", "\r", `
`, "	"], qc = ["{", "}", "|", "\\", "^", "`"].concat(zc), Wc = ["'"].concat(qc), ii = ["%", "/", "?", ";", "#"].concat(Wc), si = ["/", "?", "#"], jc = 255, ai = /^[+a-z0-9A-Z_-]{0,63}$/, $c = /^([+a-z0-9A-Z_-]{0,63})(.*)$/, ci = {
  javascript: !0,
  "javascript:": !0
}, li = {
  http: !0,
  https: !0,
  ftp: !0,
  gopher: !0,
  file: !0,
  "http:": !0,
  "https:": !0,
  "ftp:": !0,
  "gopher:": !0,
  "file:": !0
};
function Kc(e, t) {
  if (e && e instanceof Dt) return e;
  let n = new Dt();
  return n.parse(e, t), n;
}
Dt.prototype.parse = function(e, t) {
  let n, o, r, i = e;
  if (i = i.trim(), !t && e.split("#").length === 1) {
    let u = Hc.exec(i);
    if (u)
      return this.pathname = u[1], u[2] && (this.search = u[2]), this;
  }
  let s = Bc.exec(i);
  if (s && (s = s[0], n = s.toLowerCase(), this.protocol = s, i = i.substr(s.length)), (t || s || i.match(/^\/\/[^@\/]+@[^@\/]+/)) && (r = i.substr(0, 2) === "//", r && !(s && ci[s]) && (i = i.substr(2), this.slashes = !0)), !ci[s] && (r || s && !li[s])) {
    let u = -1;
    for (let d = 0; d < si.length; d++)
      o = i.indexOf(si[d]), o !== -1 && (u === -1 || o < u) && (u = o);
    let h, p;
    u === -1 ? p = i.lastIndexOf("@") : p = i.lastIndexOf("@", u), p !== -1 && (h = i.slice(0, p), i = i.slice(p + 1), this.auth = h), u = -1;
    for (let d = 0; d < ii.length; d++)
      o = i.indexOf(ii[d]), o !== -1 && (u === -1 || o < u) && (u = o);
    u === -1 && (u = i.length), i[u - 1] === ":" && u--;
    let g = i.slice(0, u);
    i = i.slice(u), this.parseHost(g), this.hostname = this.hostname || "";
    let c = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
    if (!c) {
      let d = this.hostname.split(/\./);
      for (let m = 0, f = d.length; m < f; m++) {
        let y = d[m];
        if (y && !y.match(ai)) {
          let w = "";
          for (let b = 0, S = y.length; b < S; b++)
            y.charCodeAt(b) > 127 ? w += "x" : w += y[b];
          if (!w.match(ai)) {
            let b = d.slice(0, m), S = d.slice(m + 1), k = y.match($c);
            k && (b.push(k[1]), S.unshift(k[2])), S.length && (i = S.join(".") + i), this.hostname = b.join(".");
            break;
          }
        }
      }
    }
    this.hostname.length > jc && (this.hostname = ""), c && (this.hostname = this.hostname.substr(1, this.hostname.length - 2));
  }
  let a = i.indexOf("#");
  a !== -1 && (this.hash = i.substr(a), i = i.slice(0, a));
  let l = i.indexOf("?");
  return l !== -1 && (this.search = i.substr(l), i = i.slice(0, l)), i && (this.pathname = i), li[n] && this.hostname && !this.pathname && (this.pathname = ""), this;
};
Dt.prototype.parseHost = function(e) {
  let t = Gc.exec(e);
  t && (t = t[0], t !== ":" && (this.port = t.substr(1)), e = e.substr(0, e.length - t.length)), e && (this.hostname = e);
};
var Ye = Kc;

// openclaw/node_modules/.pnpm/uc.micro@3.0.0/node_modules/uc.micro/build/index.mjs
var Tn = {};
Ht(Tn, {
  Any: () => Rn,
  Cc: () => xn,
  Cf: () => Vc,
  P: () => Ze,
  S: () => vn,
  Z: () => Cn
});
var Rn = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/, xn = /[\0-\x1F\x7F-\x9F]/, Vc = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/, Ze = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/, vn = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/, Cn = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode-codepoint.js
var Yc = [
  8364,
  0,
  8218,
  402,
  8222,
  8230,
  8224,
  8225,
  710,
  8240,
  352,
  8249,
  338,
  0,
  381,
  0,
  0,
  8216,
  8217,
  8220,
  8221,
  8226,
  8211,
  8212,
  732,
  8482,
  353,
  8250,
  339,
  0,
  382,
  376
];
function Zc(e) {
  return e === 0 || e >= 55296 && e <= 57343 || e > 1114111;
}
function di(e) {
  return Zc(e) ? 65533 : e >= 128 && e <= 159 && Yc[e - 128] || e;
}
function ui(e) {
  return e - 1 >>> 0 < 127 || e - 160 >>> 0 < 55136 ? String.fromCharCode(e) : String.fromCodePoint(di(e));
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/decode-shared.js
var J = /* @__PURE__ */ (() => {
  let e = new Uint8Array(127), t = 0;
  for (let n = 33; n <= 126; n++)
    n !== 34 && n !== 36 && n !== 92 && (e[n] = t++);
  return e;
})();
function pi(e, t, n, o, r, i) {
  let a = e.length, l = i * 90, u = 0, h = () => {
    let T = J[e.charCodeAt(u++)];
    return T < i ? T : T * 91 - l + J[e.charCodeAt(u++)];
  }, p = n - o, g = n + r, c = new Int32Array(g);
  c.fill(-1, o, i), c.fill(-1, i + p, g);
  let d = new Int32Array(g), m = new Int32Array(g);
  function f(T, M) {
    let _ = 0, A = M, q = M + T;
    for (; A < q; ) {
      let K = J[e.charCodeAt(u++)];
      if (K < 89)
        _ += K, c[A++] = _;
      else if (K === 89) {
        let j = J[e.charCodeAt(u++)] + 2;
        for (; j--; )
          c[A++] = ++_;
      } else {
        let j = J[e.charCodeAt(u++)];
        _ += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        (j < 90 ? j * 91 + J[e.charCodeAt(u++)] : J[e.charCodeAt(u++)] * 8281 + J[e.charCodeAt(u++)] * 91 + J[e.charCodeAt(u++)]), c[A++] = _;
      }
    }
  }
  f(o, 0), f(p, i);
  let y = new Int32Array(r * 2), w = 0, b = 0;
  function S(T, M) {
    for (let _ = 0; _ < T; _++) {
      let A = M + _, q = h(), K = h();
      y[b * 2] = q, y[b * 2 + 1] = K, b += 1, d[A] = w;
      let j = (c[q] < 0 ? m[q] : 1) + (c[K] < 0 ? m[K] : 1);
      m[A] = j, w += j;
    }
  }
  S(r - i + o, i + p), S(i - o, o);
  let k = new Uint16Array(w), R = 0;
  for (let T = 0; T < b; T++)
    for (let M = 0; M < 2; M++) {
      let _ = y[T * 2 + M], A = c[_];
      if (A < 0) {
        let q = d[_], K = q + m[_];
        for (; q < K; )
          k[R++] = k[q++];
      } else
        k[R++] = A;
    }
  let I = new Uint16Array(t), E = 0;
  for (; u < a; ) {
    let T = J[e.charCodeAt(u++)];
    T >= i && (T = T * 91 - l + J[e.charCodeAt(u++)]);
    let M = c[T];
    if (M < 0) {
      let _ = d[T], A = _ + m[T];
      for (; _ < A; )
        I[E++] = k[_++];
    } else
      I[E++] = M;
  }
  return I;
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/generated/decode-data-html.js
var fi = /* @__PURE__ */ pi("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/bin-trie-flags.js
var z;
(function(e) {
  e[e.VALUE_LENGTH = 49152] = "VALUE_LENGTH", e[e.FLAG13 = 8192] = "FLAG13", e[e.BRANCH_LENGTH = 8064] = "BRANCH_LENGTH", e[e.JUMP_TABLE = 127] = "JUMP_TABLE", e[e.VALUE_MASK = 8191] = "VALUE_MASK";
})(z || (z = {}));

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode.js
var $;
(function(e) {
  e[e.AMP = 38] = "AMP", e[e.NUM = 35] = "NUM", e[e.SEMI = 59] = "SEMI", e[e.EQUALS = 61] = "EQUALS", e[e.ZERO = 48] = "ZERO", e[e.NINE = 57] = "NINE", e[e.LOWER_A = 97] = "LOWER_A", e[e.LOWER_X = 120] = "LOWER_X";
})($ || ($ = {}));
var Mt = 32, mi = 21, Jc = 2097151, En = 2047, yi = 0;
function Xc(e) {
  let t = e >>> mi;
  return t === En ? yi : t;
}
function wi(e) {
  return e - $.ZERO >>> 0 <= 9;
}
function Qc(e) {
  return (e | Mt) - $.LOWER_A >>> 0 <= 5;
}
function bi(e) {
  return (e | Mt) - $.LOWER_A >>> 0 <= 25;
}
function el(e) {
  return e === $.EQUALS || bi(e) || wi(e);
}
var hi;
(function(e) {
  e[e.EntityStart = 0] = "EntityStart", e[e.NumericStart = 1] = "NumericStart", e[e.NumericDecimal = 2] = "NumericDecimal", e[e.NumericHex = 3] = "NumericHex", e[e.NamedEntity = 4] = "NamedEntity";
})(hi || (hi = {}));
var An;
(function(e) {
  e[e.Legacy = 0] = "Legacy", e[e.Strict = 1] = "Strict", e[e.Attribute = 2] = "Attribute";
})(An || (An = {}));
function tl(e, t, n, o) {
  let r = (t & z.BRANCH_LENGTH) >> 7, i = t & z.JUMP_TABLE;
  if (i) {
    if (r === 0)
      return o === i ? n : -1;
    let l = o - i;
    if (l >>> 0 >= r)
      return -1;
    let u = e[n + l];
    return u === 0 ? -1 : n + r + u - 1 & 65535;
  }
  if (r === 0)
    return -1;
  let s = r + 1 >> 1, a = n + s + r;
  for (let l = 0; l < r; l++) {
    let h = e[n + (l >> 1)] >> ((l & 1) << 3) & 255;
    if (h === o) {
      let p = n + s + l;
      return a + e[p] & 65535;
    }
    if (h > o)
      return -1;
  }
  return -1;
}
function gi(e, t, n) {
  return n === 1 ? String.fromCharCode(e[t] & z.VALUE_MASK) : n === 2 ? String.fromCharCode(e[t + 1]) : String.fromCharCode(e[t + 1], e[t + 2]);
}
function nl(e, t, n) {
  let o = t + 1, r = 0, i = o;
  if (o < n && (e.charCodeAt(o) | Mt) === $.LOWER_X)
    for (o += 1, i = o; o < n; ) {
      let a = e.charCodeAt(o);
      if (wi(a))
        r = r * 16 + (a - $.ZERO);
      else if (Qc(a))
        r = r * 16 + ((a | Mt) - $.LOWER_A + 10);
      else
        break;
      o += 1;
    }
  else
    for (; o < n; ) {
      let a = e.charCodeAt(o) - $.ZERO;
      if (a >>> 0 > 9)
        break;
      r = r * 10 + a, o += 1;
    }
  if (o === i)
    return 0;
  o < n && e.charCodeAt(o) === $.SEMI && (o += 1), r > 1114111 && (r = 1114112);
  let s = o - t;
  return s >= En && (yi = s, s = En), s << mi | r;
}
function rl(e, t, n) {
  let o = fi, r = e.indexOf("&");
  if (r < 0)
    return e;
  let i = e.length, s = 0, a = "", l = o[0], u = l & z.JUMP_TABLE, h = (l & z.BRANCH_LENGTH) >> 7;
  do {
    let p = r + 1, g = e.charCodeAt(p), c, d;
    if (g === $.NUM) {
      let m = nl(e, p, i);
      c = Xc(m), t && c > 0 && e.charCodeAt(p + c - 1) !== $.SEMI && (c = 0), d = c === 0 ? "" : ui(m & Jc);
    } else if (bi(g)) {
      c = 0, d = "";
      let m = g - u, f;
      if (m >>> 0 < h) {
        let k = o[1 + m];
        f = k === 0 ? -1 : h + k & 65535;
      } else
        f = -1;
      let y = 0, w = 0, b = f < 0 ? 0 : o[f], S = p + 1;
      e: for (; S < i; ) {
        for (
          ;
          // Value-less, non-run node with a nonzero jump offset.
          (b & (z.VALUE_LENGTH | z.FLAG13)) === 0 && (b & z.JUMP_TABLE) !== 0;
        ) {
          let E = b & z.JUMP_TABLE, T = (b & z.BRANCH_LENGTH) >> 7;
          if (T === 0) {
            if (e.charCodeAt(S) !== E)
              break e;
            f += 1;
          } else {
            let M = e.charCodeAt(S) - E;
            if (M >>> 0 >= T)
              break e;
            let _ = o[f + 1 + M];
            if (_ === 0)
              break e;
            f = f + T + _ & 65535;
          }
          if (b = o[f], S += 1, S >= i)
            break e;
        }
        if ((b & (z.VALUE_LENGTH | z.FLAG13)) === z.FLAG13) {
          let E = (b & z.BRANCH_LENGTH) >> 7;
          if (e.charCodeAt(S) !== (b & z.JUMP_TABLE))
            break;
          S += 1;
          let T = E - 1, M = f + 1, _ = 0;
          for (; _ + 1 < T; _ += 2) {
            let A = o[M];
            if (e.charCodeAt(S) !== (A & 255) || (S += 1, e.charCodeAt(S) !== (A >> 8 & 255)))
              break e;
            S += 1, M += 1;
          }
          if (_ < T) {
            if (e.charCodeAt(S) !== (o[M] & 255))
              break;
            S += 1;
          }
          f += 1 + (E >> 1), b = o[f];
          continue;
        }
        let k = b >>> 14, R = e.charCodeAt(S);
        if (k !== 0) {
          if (R === $.SEMI) {
            c = S - p + 1, d = k === 1 ? String.fromCharCode(b & z.VALUE_MASK) : gi(o, f, k);
            break;
          }
          if (!t && (b & z.FLAG13) === 0 && (c = S - p, y = f, w = k), k === 1)
            break;
        }
        let I = tl(o, b, f + (k || 1), R);
        if (I < 0)
          break;
        f = I, b = o[f], S += 1;
      }
      if (d === "") {
        let k = b >>> 14;
        k !== 0 && !t && (b & z.FLAG13) === 0 && (c = S - p, y = f, w = k), c > 0 && (d = gi(o, y, w));
      }
    } else
      c = 0, d = "";
    c === 0 || n && g !== $.NUM && e.charCodeAt(p + c - 1) !== $.SEMI && p + c < i && el(e.charCodeAt(p + c)) ? r = p : (s < r && (a += e.slice(s, r)), a += d, r = s = p + c), e.charCodeAt(r) !== $.AMP && (r = e.indexOf("&", r));
  } while (r >= 0);
  return a + e.slice(s);
}
function Ot(e) {
  return rl(e, !0, !1);
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/index.js
var Si;
(function(e) {
  e[e.XML = 0] = "XML", e[e.HTML = 1] = "HTML";
})(Si || (Si = {}));
var ki;
(function(e) {
  e[e.UTF8 = 0] = "UTF8", e[e.ASCII = 1] = "ASCII", e[e.Extensive = 2] = "Extensive", e[e.Attribute = 3] = "Attribute", e[e.Text = 4] = "Text";
})(ki || (ki = {}));

// openclaw/node_modules/.pnpm/linkify-it@6.1.0/node_modules/linkify-it/build/index.mjs
var il = class {
  src_Any = Rn.source;
  src_Cc = xn.source;
  src_Z = Cn.source;
  src_P = Ze.source;
  src_ZPCc = [
    this.src_Z,
    this.src_P,
    this.src_Cc
  ].join("|");
  src_ZCc = [this.src_Z, this.src_Cc].join("|");
  cache = {};
  opts = {
    maxLength: 1e4,
    urlAuth: !1,
    schema_names: []
  };
  constructor(e = {}) {
    this.opts = {
      ...this.opts,
      ...e
    };
  }
  set(e = {}) {
    return this.opts = {
      ...this.opts,
      ...e
    }, this.cache = {}, this;
  }
  escapeRE(e) {
    return e.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
  }
  nestedPairRE(e, t, n = 4) {
    let o = this.escapeRE(e), r = this.escapeRE(t), i = `(?:(?!${this.src_ZCc}|${o}|${r}).)`, s = `${o}${i}{0,1000}${r}`;
    for (let a = 2; a <= n; a++) s = `${o}(?:${i}|${s}){0,1000}${r}`;
    return s;
  }
  get_text_separators() {
    return this.cache.text_separators ??= /[><\uff5c]/;
  }
  get_pseudo_letter() {
    return this.cache.src_pseudo_letter ??= new RegExp(`(?:(?!${this.get_text_separators().source}|${this.src_ZPCc})${this.src_Any})`);
  }
  get_ipv4_addr() {
    return this.cache.src_ip4 ??= /* @__PURE__ */ new RegExp("(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])");
  }
  get_ipv6_addr() {
    let e = "[0-9A-Fa-f]{1,4}", t = `(?:(?:${e}:${e})|${this.get_ipv4_addr().source})`;
    return this.cache.src_ip6_addr ??= new RegExp(`(?:(?:${e}:){6}${t}|::(?:${e}:){5}${t}|(?:${e})?::(?:${e}:){4}${t}|(?:(?:${e}:){0,1}${e})?::(?:${e}:){3}${t}|(?:(?:${e}:){0,2}${e})?::(?:${e}:){2}${t}|(?:(?:${e}:){0,3}${e})?::${e}:${t}|(?:(?:${e}:){0,4}${e})?::${t}|(?:(?:${e}:){0,5}${e})?::${e}|(?:(?:${e}:){0,6}${e})?::)`);
  }
  get_ipv6_url_host() {
    return this.cache.src_ip6_host ??= new RegExp(`\\[${this.get_ipv6_addr().source}\\]`);
  }
  get_ipv6_mail_host() {
    return this.cache.src_ipv6_mail_host ??= new RegExp(`\\[IPv6:${this.get_ipv6_addr().source}\\]`);
  }
  get_auth() {
    return this.cache.src_auth ??= new RegExp(`(?:(?:(?!${this.src_ZCc}|[@/\\[\\]()]).){1,50}@)?`);
  }
  get_port() {
    return this.cache.src_port ??= /* @__PURE__ */ new RegExp("(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?");
  }
  get_host_terminator() {
    return this.cache.src_host_terminator ??= new RegExp(`(?=$|${this.get_text_separators().source}|${this.src_ZPCc})(?!${this.opts["---"] ? "-(?!--)|" : "-|"}_|:\\d|\\.-|\\.(?!$|${this.src_ZPCc}))`);
  }
  get_path_terminator() {
    return this.cache.src_path_terminator ??= new RegExp(`${this.src_ZPCc}|${this.get_text_separators().source}`);
  }
  get_path() {
    return this.cache.src_path ??= new RegExp(`(?:[/?#](?:${this.nestedPairRE("[", "]")}|${this.nestedPairRE("(", ")")}|${this.nestedPairRE("{", "}")}|\\"(?:(?!${this.src_ZCc}|["]).){1,100}\\"|\\'(?:(?!${this.src_ZCc}|[']).){1,100}\\'|\\'(?=${this.get_pseudo_letter().source}|[-])|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${this.src_ZCc}|[.]|$)|` + (this.opts["---"] ? "\\-(?!--(?:[^-]|$))(?:-{0,19})|" : "\\-{1,20}|") + `,(?!${this.src_ZCc}|$)|;(?!${this.src_ZCc}|$)|\\!{1,20}(?!${this.src_ZCc}|[!]|$)|\\?(?!${this.src_ZCc}|[?]|$)|` + this.get_path_extra().source + `[\\\\/:%@#&=_~*]|(?!${this.get_path_terminator().source}).){1,${this.opts.maxLength}}|\\/)?`);
  }
  get_mail_name() {
    return this.cache.src_mail_name ??= /* @__PURE__ */ new RegExp("[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9](?:[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]|[.](?=[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9])){0,63}");
  }
  get_xn() {
    return this.cache.src_xn ??= /* @__PURE__ */ new RegExp("xn--[a-z0-9\\-]{1,59}");
  }
  get_tld() {
    if (this.cache.tld) return this.cache.tld;
    let e = [...new Set(this.opts.tlds || [])].sort().reverse().join("|");
    return this.cache.tld = new RegExp(`${e || "$#none#$"}|${this.get_xn().source}`), this.cache.tld;
  }
  get_domain_root() {
    return this.cache.src_domain_root ??= new RegExp("(?:" + this.get_xn().source + `|${this.get_pseudo_letter().source}{1,63})`);
  }
  get_domain() {
    return this.cache.src_domain ??= new RegExp("(?:" + this.get_xn().source + `|(?:${this.get_pseudo_letter().source})|(?:${this.get_pseudo_letter().source}(?:-|${this.get_pseudo_letter().source}){0,61}${this.get_pseudo_letter().source}))`);
  }
  get_url_host_port() {
    return this.cache.url_host_port ??= new RegExp("(?:" + this.get_ipv6_url_host().source + `|(?:(?:(?:${this.get_domain().source})\\.){0,10}${this.get_domain().source}))` + this.get_port().source + this.get_host_terminator().source);
  }
  get_fuzzy_url_host_port() {
    return this.cache.fuzzy_url_host_port ??= new RegExp("(?:" + (this.opts.fuzzyIP ? this.get_ipv4_addr().source + "|" : "") + `(?:(?:(?:${this.get_domain().source})\\.){1,10}(?:${this.get_tld().source})))` + this.get_host_terminator().source);
  }
  get_mail_host() {
    return this.cache.src_mail_host ??= new RegExp("(?:" + this.get_ipv6_mail_host().source + `|(?:(?:(?:${this.get_domain().source})\\.){0,4}${this.get_domain().source}))` + this.get_host_terminator().source);
  }
  get_fuzzy_mail_host() {
    return this.cache.src_fuzzy_mail_host ??= new RegExp("(?:" + this.get_ipv6_mail_host().source + `|(?:(?:(?:${this.get_domain().source})[.]){1,4}${this.get_domain_root().source}))` + this.get_host_terminator().source);
  }
  get_path_extra() {
    return this.cache.src_path_extra ??= /* @__PURE__ */ new RegExp("");
  }
  get_fuzzy_mail_host_search() {
    return this.cache.mail_fuzzy_host_search ??= new RegExp(`@${this.get_fuzzy_mail_host().source}`, "ig");
  }
  get_fuzzy_link_search() {
    return this.cache.link_fuzzy_search ??= new RegExp(`(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uFF5C]|${this.src_ZPCc}))(?:(?![$+<=>^\`|\uFF5C])${this.get_fuzzy_url_host_port().source}${this.get_path().source})`, "ig");
  }
  get_http_validator() {
    return this.cache.http_validator ??= new RegExp("\\/\\/" + (this.opts.urlAuth ? this.get_auth().source : "") + this.get_url_host_port().source + this.get_path().source, "iy");
  }
  get_relative_proto_validator() {
    return this.cache.relative_proto_validator ??= new RegExp((this.opts.urlAuth ? this.get_auth().source : "") + `(?:localhost|${this.get_ipv6_url_host().source}|(?:(?:${this.get_domain().source})[.]){1,10}${this.get_domain_root().source})` + this.get_port().source + this.get_host_terminator().source + this.get_path().source, "iy");
  }
  get_mail_name_validator() {
    return this.cache.mail_name_validator ??= new RegExp(`(?:^|${this.get_text_separators().source}|"|\\(|${this.src_ZCc})(${this.get_mail_name().source})$`);
  }
  get_mailto_validator() {
    return this.cache.mailto_validator ??= new RegExp(`${this.get_mail_name().source}@${this.get_mail_host().source}`, "iy");
  }
  get_schema_names() {
    return this.cache.schema_names ??= new RegExp((this.opts.schema_names || []).map((e) => this.escapeRE(e)).join("|"));
  }
  get_schema_search() {
    return this.cache.schema_search ??= new RegExp(`(^|(?!_)(?:[><\uFF5C]|${this.src_ZPCc}))(${this.get_schema_names().source})`, "ig");
  }
  get_schema_at_start() {
    return this.cache.schema_at_start ??= new RegExp(`^${this.get_schema_search().source}`, "i");
  }
}, _n = {
  validate: (e, t, n) => {
    let o = n.re.get_http_validator();
    o.lastIndex = t;
    let r = o.exec(e);
    return r ? r[0].length : 0;
  },
  normalize: (e, t) => t.normalize(e)
}, sl = {
  "http:": _n,
  "https:": _n,
  "ftp:": _n,
  "//": {
    validate: function(e, t, n) {
      let o = n.re.get_relative_proto_validator();
      o.lastIndex = t;
      let r = o.exec(e);
      return r ? t >= 3 && e[t - 3] === ":" || t >= 3 && e[t - 3] === "/" ? 0 : r[0].length : 0;
    },
    normalize: (e, t) => t.normalize(e)
  },
  "mailto:": {
    validate: function(e, t, n) {
      let o = n.re.get_mailto_validator();
      o.lastIndex = t;
      let r = o.exec(e);
      return r ? r[0].length : 0;
    },
    normalize: (e, t) => t.normalize(e)
  }
}, al = "a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw", cl = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444";
function ll() {
  let e = cl.split("|");
  return al.split("|").forEach((t) => {
    let n = t.indexOf(":"), o = t.slice(0, n);
    for (let r of t.slice(n + 1)) e.push(o + r);
  }), e;
}
var dl = {
  fuzzyLink: !1,
  fuzzyEmail: !0,
  fuzzyIP: !1,
  "---": !1,
  tlds: ll(),
  urlAuth: !1,
  maxLength: 1e4
}, Ri = class {
  /** Prefix (protocol) for matched string. Empty for fuzzy links. */
  schema;
  /** First position of matched string. */
  index;
  /** Next position after matched string. */
  lastIndex;
  /** Matched string. */
  raw;
  /** Normalized text of matched string. */
  text;
  /** Normalized URL of matched string. */
  url;
  constructor(e, t, n, o) {
    let r = e.slice(n, o);
    this.schema = t.toLowerCase(), this.index = n, this.lastIndex = o, this.raw = r, this.text = r, this.url = r;
  }
}, xi = class {
  __opts__;
  __schemas__;
  re;
  /**
  * Creates new linkifier instance.
  *
  * By default understands:
  *
  * - `http(s)://...` , `ftp://...`, `mailto:...` & `//...` links
  * - "fuzzy" emails (foo@bar.com).
  *
  * See {@link LinkifyConstructorOptions} for available options.
  *
  * @param options Recognition options.
  *
  * @example
  * ```javascript
  * import { LinkifyIt } from 'linkify-it'
  *
  * const linkify = new LinkifyIt({ fuzzyLink: true })
  *
  * linkify
  *   .tlds(require('tlds'))       // Reload with full TLD list
  *   .tlds('onion', true)         // Add unofficial `.onion` domain
  *   .add('ftp:', null)           // Disable `ftp:` protocol
  *   .set({ fuzzyIP: true })      // Enable IPs in fuzzy links
  *
  * console.log(linkify.test('Site github.com!')) // true
  * console.log(linkify.match('Site github.com!'))
  * ```
  */
  constructor(e = {}) {
    let { rebuilder: t, ...n } = e;
    this.__opts__ = {
      ...dl,
      ...n
    }, this.__schemas__ = { ...sl }, this.re = t || new il(), this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    });
  }
  /**
  * Add new rule definition.
  *
  * `schema` is a link prefix (usually, protocol name with `:` at the end,
  * `skype:` for example). `linkify-it` makes sure that prefix is not
  * preceded with alphanumeric char and symbols. Only whitespaces and
  * punctuation allowed.
  *
  * `definition` is a rule to check tail after link prefix. To disable an
  * existing rule, pass `null`.
  *
  * @param schema Rule name (fixed pattern prefix).
  * @param definition Schema definition, or `null` to disable the rule.
  *
  * See [twitter mentions example](https://github.com/markdown-it/linkify-it/blob/master/examples/twitter.mjs).
  */
  add(e, t = null) {
    if (!t) delete this.__schemas__[e];
    else {
      let n = {
        normalize: (o, r) => r.normalize(o),
        ...t
      };
      this.__schemas__[e] = n;
    }
    return this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Set recognition options for links without schema.
  *
  * @param options Recognition options.
  */
  set(e = {}) {
    return this.__opts__ = {
      ...this.__opts__,
      ...e
    }, this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Searches linkifiable pattern and returns `true` on success or `false` on fail.
  *
  * @param text Text to scan.
  */
  test(e) {
    if (!e.length) return !1;
    let t, n;
    for (n = this.re.get_schema_search(), n.lastIndex = 0; (t = n.exec(e)) !== null; ) if (this.testSchemaAt(e, t[2], n.lastIndex)) return !0;
    if (this.__opts__.fuzzyLink && this.__schemas__["http:"] && (n = this.re.get_fuzzy_link_search(), n.lastIndex = 0, n.exec(e) !== null))
      return !0;
    if (this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && e.indexOf("@") >= 0) {
      let o = this.re.get_fuzzy_mail_host_search(), r = this.re.get_mail_name_validator();
      for (o.lastIndex = 0; (t = o.exec(e)) !== null; ) {
        let i = e.slice(Math.max(0, t.index - 65), t.index);
        if (r.test(i)) return !0;
      }
    }
    return !1;
  }
  /**
  * Similar to {@link LinkifyIt.test} but checks only specific protocol tail exactly
  * at given position. Returns length of found pattern (0 on fail).
  *
  * @param text Text to scan.
  * @param schema Rule (schema) name.
  * @param pos Text offset to check from.
  */
  testSchemaAt(e, t, n) {
    return this.__schemas__[t.toLowerCase()] ? this.__schemas__[t.toLowerCase()].validate(e.slice(0, n + this.__opts__.maxLength), n, this) : 0;
  }
  /**
  * Returns array of found link descriptions or `null` on fail. We strongly
  * recommend to use {@link LinkifyIt.test} first, for best speed.
  *
  * @param text Text to scan.
  */
  match(e) {
    let t = [], n = this.re.get_schema_search(), o, r, i, s, a, l, u = !1, h = !1, p = !1, g = 0;
    if (!e.length) return null;
    for (n.lastIndex = 0, this.__opts__.fuzzyLink && this.__schemas__["http:"] && (o = this.re.get_fuzzy_link_search(), o.lastIndex = 0), this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && (r = this.re.get_fuzzy_mail_host_search(), r.lastIndex = 0, i = this.re.get_mail_name_validator()); ; ) {
      let c = Math.max(g - 1, 0);
      if (r && i && !p && (!a || a.index < g))
        for (r.lastIndex < c && (r.lastIndex = c); ; ) {
          let w = r.exec(e);
          if (!w) {
            p = !0, a = void 0;
            break;
          }
          let b = i.exec(e.slice(Math.max(0, w.index - 65), w.index));
          if (b) {
            if (a = {
              schema: "mailto:",
              index: w.index - b[1].length,
              lastIndex: w.index + w[0].length
            }, a.index >= g) break;
            r.lastIndex < c && (r.lastIndex = c);
          }
        }
      if (o && !h && (!s || s.index < g))
        for (o.lastIndex < c && (o.lastIndex = c); ; ) {
          let w = o.exec(e);
          if (!w) {
            h = !0, s = void 0;
            break;
          }
          if (s = {
            schema: "",
            index: w.index + w[1].length,
            lastIndex: w.index + w[0].length
          }, s.index >= g) break;
          o.lastIndex < c && (o.lastIndex = c);
        }
      let d = a;
      (!d || s && (s.index < d.index || s.index === d.index && s.lastIndex > d.lastIndex)) && (d = s);
      let m;
      if (!u) for (; ; ) {
        if (!l) {
          n.lastIndex < c && (n.lastIndex = c);
          let S = n.exec(e);
          if (!S) {
            u = !0;
            break;
          }
          l = {
            schema: S[2],
            index: S.index + S[1].length,
            lastIndex: S.index + S[0].length
          };
        }
        if (l.index < g) {
          l = void 0;
          continue;
        }
        if (d && l.index > d.index) break;
        let w = l;
        l = void 0;
        let b = this.testSchemaAt(e, w.schema, w.lastIndex);
        if (b) {
          m = {
            schema: w.schema,
            index: w.index,
            lastIndex: w.lastIndex + b
          };
          break;
        }
      }
      let f = m;
      if ((!f || a && (a.index < f.index || a.index === f.index && a.lastIndex > f.lastIndex)) && (f = a), (!f || s && (s.index < f.index || s.index === f.index && s.lastIndex > f.lastIndex)) && (f = s), !f) break;
      f === a ? a = void 0 : f === s && (s = void 0);
      let y = new Ri(e, f.schema, f.index, f.lastIndex);
      y.schema ? this.__schemas__[y.schema].normalize(y, this) : this.normalize(y), t.push(y), g = f.lastIndex;
    }
    return t.length ? t : null;
  }
  /**
  * Returns fully-formed (not fuzzy) link if it starts at the beginning
  * of the string, and null otherwise.
  *
  * @param text Text to scan.
  */
  matchAtStart(e) {
    if (!e.length) return null;
    let t = this.re.get_schema_at_start().exec(e);
    if (!t) return null;
    let n = this.testSchemaAt(e, t[2], t[0].length);
    if (!n) return null;
    let o = new Ri(e, t[2], t.index + t[1].length, t.index + t[0].length + n);
    return this.__schemas__[o.schema].normalize(o, this), o;
  }
  /**
  * Load (or merge) new TLDs list. Those are used for fuzzy links (without
  * prefix) to avoid false positives. By default this algorithm is used:
  *
  * - hostname with any 2-letter root zones are ok.
  * - biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф
  *   are ok.
  * - encoded (`xn--...`) root zones are ok.
  *
  * If list is replaced, then exact match for 2-chars root zones will be checked.
  *
  * @param list List of TLDs.
  * @param keepOld Merge with current list if `true` (`false` by default).
  */
  tlds(e, t = !1) {
    return e = Array.isArray(e) ? e : [e], t ? this.__opts__.tlds = this.__opts__.tlds.concat(e) : this.__opts__.tlds = e, this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Default normalizer (if schema does not define its own).
  *
  * @param match Match to normalize.
  */
  normalize(e) {
    e.schema || (e.url = `http://${e.url}`), e.schema === "mailto:" && !/^mailto:/i.test(e.url) && (e.url = `mailto:${e.url}`);
  }
};

// openclaw/node_modules/.pnpm/markdown-it@15.0.2/node_modules/markdown-it/dist/markdown-it.mjs
var Un = zn(Pi(), 1);
var Di = Object.defineProperty, Wi = (e, t) => {
  let n = {};
  for (var o in e) Di(n, o, {
    get: e[o],
    enumerable: !0
  });
  return t || Di(n, Symbol.toStringTag, { value: "Module" }), n;
}, kl = /* @__PURE__ */ Wi({
  arrayReplaceAt: () => Rl,
  asciiTrim: () => Lt,
  callable: () => ji,
  escapeHtml: () => fe,
  escapeRE: () => Dl,
  fromCodePoint: () => Je,
  isMdAsciiPunct: () => et,
  isPunctChar: () => Ki,
  isPunctCharCode: () => Qe,
  isSpace: () => N,
  isValidEntityCode: () => Fn,
  isWhiteSpace: () => Xe,
  lib: () => Ml,
  normalizeReference: () => Ft,
  unescapeAll: () => Le,
  unescapeMd: () => Tl
});
function ji(e) {
  let t = function(...n) {
    return Reflect.construct(e, n, new.target && new.target !== t ? new.target : e);
  };
  return Object.defineProperty(t, "name", { value: e.name }), Object.setPrototypeOf(t, e), t.prototype = e.prototype, t;
}
function Rl(e, t, n) {
  return [].concat(e.slice(0, t), n, e.slice(t + 1));
}
function Fn(e) {
  return !(e >= 55296 && e <= 57343 || e >= 64976 && e <= 65007 || (e & 65535) === 65535 || (e & 65535) === 65534 || e >= 0 && e <= 8 || e === 11 || e >= 14 && e <= 31 || e >= 127 && e <= 159 || e > 1114111);
}
function Je(e) {
  if (e > 65535) {
    e -= 65536;
    let t = 55296 + (e >> 10), n = 56320 + (e & 1023);
    return String.fromCharCode(t, n);
  }
  return String.fromCharCode(e);
}
var $i = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, xl = new RegExp(`${$i.source}|${/&([a-z#][a-z0-9]{1,31});/gi.source}`, "gi"), vl = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function Cl(e, t) {
  if (t.charCodeAt(0) === 35 && vl.test(t)) {
    let o = t[1].toLowerCase() === "x" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
    return Fn(o) ? Je(o) : e;
  }
  let n = Ot(e);
  return n !== e ? n : e;
}
function Tl(e) {
  return e.indexOf("\\") < 0 ? e : e.replace($i, "$1");
}
function Le(e) {
  return e.indexOf("\\") < 0 && e.indexOf("&") < 0 ? e : e.replace(xl, function(t, n, o) {
    return n || Cl(t, o);
  });
}
var El = /[&<>"]/, Al = /[&<>"]/g, _l = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function Il(e) {
  return _l[e];
}
function fe(e) {
  return El.test(e) ? e.replace(Al, Il) : e;
}
var Pl = /[.?*+^$[\]\\(){}|-]/g;
function Dl(e) {
  return e.replace(Pl, "\\$&");
}
function N(e) {
  switch (e) {
    case 9:
    case 32:
      return !0;
  }
  return !1;
}
function Xe(e) {
  if (e >= 8192 && e <= 8202) return !0;
  switch (e) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 32:
    case 160:
    case 5760:
    case 8239:
    case 8287:
    case 12288:
      return !0;
  }
  return !1;
}
function Ki(e) {
  return Ze.test(e) || vn.test(e);
}
function Qe(e) {
  return Ki(Je(e));
}
function et(e) {
  switch (e) {
    case 33:
    case 34:
    case 35:
    case 36:
    case 37:
    case 38:
    case 39:
    case 40:
    case 41:
    case 42:
    case 43:
    case 44:
    case 45:
    case 46:
    case 47:
    case 58:
    case 59:
    case 60:
    case 61:
    case 62:
    case 63:
    case 64:
    case 91:
    case 92:
    case 93:
    case 94:
    case 95:
    case 96:
    case 123:
    case 124:
    case 125:
    case 126:
      return !0;
    default:
      return !1;
  }
}
function Ft(e) {
  return e = e.trim().replace(/\s+/g, " "), e.toLowerCase().toUpperCase();
}
function Mi(e) {
  return e === 32 || e === 9 || e === 10 || e === 13;
}
function Lt(e) {
  let t = 0;
  for (; t < e.length && Mi(e.charCodeAt(t)); t++) ;
  let n = e.length - 1;
  for (; n >= t && Mi(e.charCodeAt(n)); n--) ;
  return e.slice(t, n + 1);
}
var Ml = {
  mdurl: kn,
  ucmicro: Tn
};
function Ol(e, t, n) {
  let o, r, i, s, a = e.posMax, l = e.pos;
  for (e.pos = t + 1, o = 1; e.pos < a; ) {
    if (i = e.src.charCodeAt(e.pos), i === 93 && (o--, o === 0)) {
      r = !0;
      break;
    }
    if (s = e.pos, e.md.inline.skipToken(e), i === 91) {
      if (s === e.pos - 1) o++;
      else if (n)
        return e.pos = l, -1;
    }
  }
  let u = -1;
  return r && (u = e.pos), e.pos = l, u;
}
function Nl(e, t, n) {
  let o, r = t, i = {
    ok: !1,
    pos: 0,
    str: ""
  };
  if (e.charCodeAt(r) === 60) {
    for (r++; r < n; ) {
      if (o = e.charCodeAt(r), o === 10 || o === 60) return i;
      if (o === 62)
        return i.pos = r + 1, i.str = Le(e.slice(t + 1, r)), i.ok = !0, i;
      if (o === 92 && r + 1 < n) {
        r += 2;
        continue;
      }
      r++;
    }
    return i;
  }
  let s = 0;
  for (; r < n && (o = e.charCodeAt(r), !(o === 32 || o < 32 || o === 127)); ) {
    if (o === 92 && r + 1 < n) {
      if (e.charCodeAt(r + 1) === 32) {
        r++;
        continue;
      }
      r += 2;
      continue;
    }
    if (o === 40 && (s++, s > 32))
      return i;
    if (o === 41) {
      if (s === 0) break;
      s--;
    }
    r++;
  }
  return t === r || s !== 0 || (i.str = Le(e.slice(t, r)), i.pos = r, i.ok = !0), i;
}
function Ul(e, t, n, o) {
  let r, i = t, s = {
    ok: !1,
    can_continue: !1,
    pos: 0,
    str: "",
    marker: 0
  };
  if (o)
    s.str = o.str, s.marker = o.marker;
  else {
    if (i >= n) return s;
    let a = e.charCodeAt(i);
    if (a !== 34 && a !== 39 && a !== 40) return s;
    t++, i++, a === 40 && (a = 41), s.marker = a;
  }
  for (; i < n; ) {
    if (r = e.charCodeAt(i), r === s.marker)
      return s.pos = i + 1, s.str += Le(e.slice(t, i)), s.ok = !0, s;
    if (r === 40 && s.marker === 41) return s;
    r === 92 && i + 1 < n && i++, i++;
  }
  return s.can_continue = !0, s.str += Le(e.slice(t, i)), s;
}
var Fl = /* @__PURE__ */ Wi({
  parseLinkDestination: () => Nl,
  parseLinkLabel: () => Ol,
  parseLinkTitle: () => Ul
});
function tt(e) {
  "@babel/helpers - typeof";
  return tt = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(t) {
    return typeof t;
  } : function(t) {
    return t && typeof Symbol == "function" && t.constructor === Symbol && t !== Symbol.prototype ? "symbol" : typeof t;
  }, tt(e);
}
function Ll(e, t) {
  if (tt(e) != "object" || !e) return e;
  var n = e[Symbol.toPrimitive];
  if (n !== void 0) {
    var o = n.call(e, t || "default");
    if (tt(o) != "object") return o;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (t === "string" ? String : Number)(e);
}
function Bl(e) {
  var t = Ll(e, "string");
  return tt(t) == "symbol" ? t : t + "";
}
function v(e, t, n) {
  return (t = Bl(t)) in e ? Object.defineProperty(e, t, {
    value: n,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[t] = n, e;
}
var Ae = class {
  constructor(e, t, n) {
    v(
      this,
      /**
      * Source map info. Format: `[ line_begin, line_end ]`
      */
      "map",
      null
    ), v(
      this,
      /**
      * nesting level, the same as `state.level`
      */
      "level",
      0
    ), v(
      this,
      /**
      * An array of child nodes (inline and img tokens)
      */
      "children",
      null
    ), v(
      this,
      /**
      * In a case of self-closing tag (code, html, fence, etc.),
      * it has contents of this tag.
      */
      "content",
      ""
    ), v(
      this,
      /**
      * '*' or '_' for emphasis, fence string for fence, etc.
      */
      "markup",
      ""
    ), v(
      this,
      /**
      * Additional information:
      *
      * - Info string for "fence" tokens
      * - The value "auto" for autolink "link_open" and "link_close" tokens
      * - The string value of the item marker for ordered-list "list_item_open" tokens
      */
      "info",
      ""
    ), v(
      this,
      /**
      * True for block-level tokens, false for inline tokens.
      * Used in renderer to calculate line breaks
      */
      "block",
      !1
    ), v(
      this,
      /**
      * If it's true, ignore this element when rendering. Used for tight lists
      * to hide paragraphs.
      */
      "hidden",
      !1
    ), this.type = e, this.tag = t, this.attrs = null, this.nesting = n, this.meta = null;
  }
  /**
  * Search attribute index by name.
  */
  attrIndex(e) {
    if (!this.attrs) return -1;
    let t = this.attrs;
    for (let n = 0, o = t.length; n < o; n++) if (t[n][0] === e) return n;
    return -1;
  }
  /**
  * Add `[ name, value ]` attribute to list. Init attrs if necessary
  */
  attrPush(e) {
    this.attrs ? this.attrs.push(e) : this.attrs = [e];
  }
  /**
  * Set `name` attribute to `value`. Override old value if exists.
  */
  attrSet(e, t) {
    let n = this.attrIndex(e), o = [e, t];
    n < 0 ? this.attrPush(o) : this.attrs[n] = o;
  }
  /**
  * Get the value of attribute `name`, or null if it does not exist.
  */
  attrGet(e) {
    let t = this.attrIndex(e), n = null;
    return t >= 0 && (n = this.attrs[t][1]), n;
  }
  /**
  * Join value to existing attribute via space. Or create new attribute if not
  * exists. Useful to operate with token classes.
  */
  attrJoin(e, t) {
    let n = this.attrIndex(e);
    n < 0 ? this.attrPush([e, t]) : this.attrs[n][1] = `${this.attrs[n][1]} ${t}`;
  }
}, nt = class {
  constructor() {
    v(
      this,
      /** @internal */
      "__rules__",
      []
    ), v(
      this,
      /** @internal */
      "__cache__",
      null
    );
  }
  /** @internal */
  __find__(e) {
    for (let t = 0; t < this.__rules__.length; t++) if (this.__rules__[t].name === e) return t;
    return -1;
  }
  /** @internal */
  __compile__() {
    let e = /* @__PURE__ */ new Set();
    this.__rules__.forEach((t) => {
      t.enabled && t.alt.forEach((n) => {
        n && e.add(n);
      });
    }), this.__cache__ = /* @__PURE__ */ Object.create(null), this.__cache__[""] = [], this.__rules__.forEach((t) => {
      t.enabled && this.__cache__[""].push(t.fn);
    }), e.forEach((t) => {
      this.__cache__[t] = [], this.__rules__.forEach((n) => {
        n.enabled && n.alt.indexOf(t) >= 0 && this.__cache__[t].push(n.fn);
      });
    });
  }
  /**
  * Replace rule by name with new function & options. Throws error if name not
  * found.
  *
  * @example Replace existing typographer replacement rule with new one
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.core.ruler.at('replacements', function replace(state) {
  *   //...
  * });
  * ```
  */
  at(e, t, n = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__[o].fn = t, this.__rules__[o].alt = n.alt || [], this.__cache__ = null;
  }
  /**
  * Add new rule to chain before one with given name. See also
  * {@link Ruler.after}, {@link Ruler.push}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.block.ruler.before('paragraph', 'my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  before(e, t, n, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r, 0, {
      name: t,
      enabled: !0,
      fn: n,
      alt: o.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Add new rule to chain after one with given name. See also
  * {@link Ruler.before}, {@link Ruler.push}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.inline.ruler.after('text', 'my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  after(e, t, n, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r + 1, 0, {
      name: t,
      enabled: !0,
      fn: n,
      alt: o.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Push new rule to the end of chain. See also
  * {@link Ruler.before}, {@link Ruler.after}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.core.ruler.push('my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  push(e, t, n = {}) {
    this.__rules__.push({
      name: e,
      enabled: !0,
      fn: t,
      alt: n.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Enable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  enable(e, t = !1) {
    Array.isArray(e) || (e = [e]);
    let n = [];
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (t) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !0, n.push(o);
    }), this.__cache__ = null, n;
  }
  /**
  * Enable rules with given names, and disable everything else. If any rule name
  * not found - throw Error. Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enable}.
  */
  enableOnly(e, t = !1) {
    Array.isArray(e) || (e = [e]), this.__rules__.forEach((n) => {
      n.enabled = !1;
    }), this.enable(e, t);
  }
  /**
  * Disable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.enable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  disable(e, t = !1) {
    Array.isArray(e) || (e = [e]);
    let n = [];
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (t) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !1, n.push(o);
    }), this.__cache__ = null, n;
  }
  /**
  * Return array of active functions (rules) for given chain name. It analyzes
  * rules configuration, compiles caches if not exists and returns result.
  *
  * Default chain name is `''` (empty string). It can't be skipped. That's
  * done intentionally, to keep signature monomorphic for high speed.
  */
  getRules(e) {
    return this.__cache__ || this.__compile__(), this.__cache__[e] || [];
  }
}, te = {};
te.code_inline = function(e, t, n, o, r) {
  let i = e[t];
  return `<code${r.renderAttrs(i)}>${fe(i.content)}</code>`;
};
te.code_block = function(e, t, n, o, r) {
  let i = e[t];
  return `<pre${r.renderAttrs(i)}><code>${fe(e[t].content)}</code></pre>
`;
};
te.fence = function(e, t, n, o, r) {
  let i = e[t], s = i.info ? Le(i.info).trim() : "", a = "", l = "";
  if (s) {
    let h = s.split(/(\s+)/g);
    a = h[0], l = h.slice(2).join("");
  }
  let u;
  if (n.highlight ? u = n.highlight(i.content, a, l) || fe(i.content) : u = fe(i.content), u.indexOf("<pre") === 0) return u + `
`;
  if (s) {
    let h = i.attrIndex("class"), p = i.attrs ? i.attrs.slice() : [];
    h < 0 ? p.push(["class", `${n.langPrefix}${a}`]) : (p[h] = [p[h][0], p[h][1]], p[h][1] += ` ${n.langPrefix}${a}`);
    let g = { attrs: p };
    return `<pre><code${r.renderAttrs(g)}>${u}</code></pre>
`;
  }
  return `<pre><code${r.renderAttrs(i)}>${u}</code></pre>
`;
};
te.image = function(e, t, n, o, r) {
  let i = e[t];
  return i.attrs[i.attrIndex("alt")][1] = r.renderInlineAsText(i.children, n, o), r.renderToken(e, t, n);
};
te.hardbreak = function(e, t, n) {
  return n.xhtmlOut ? `<br />
` : `<br>
`;
};
te.softbreak = function(e, t, n) {
  return n.breaks ? n.xhtmlOut ? `<br />
` : `<br>
` : `
`;
};
te.text = function(e, t) {
  return fe(e[t].content);
};
te.html_block = function(e, t) {
  return e[t].content;
};
te.html_inline = function(e, t) {
  return e[t].content;
};
var Vi = class {
  constructor() {
    v(
      this,
      /**
      * Contains render rules for tokens. Can be updated and extended.
      *
      * See [source code](https://github.com/markdown-it/markdown-it/blob/master/src/renderer.ts)
      * for more details and examples.
      *
      * @example Custom render rules
      * ```javascript
      * import MarkdownIt from 'markdown-it'
      * const md = new MarkdownIt()
      *
      * md.renderer.rules.strong_open  = function () { return '<b>'; };
      * md.renderer.rules.strong_close = function () { return '</b>'; };
      *
      * const result = md.renderInline(...);
      * ```
      *
      * @example Each rule is called as independent static function with fixed signature
      * ```javascript
      * function my_token_render(tokens, idx, options, env, renderer) {
      *   // ...
      *   return renderedHTML;
      * }
      * ```
      */
      "rules",
      Object.assign({}, te)
    );
  }
  /**
  * Render token attributes to string.
  */
  renderAttrs(e) {
    let t, n, o;
    if (!e.attrs) return "";
    for (o = "", t = 0, n = e.attrs.length; t < n; t++) o += ` ${fe(e.attrs[t][0])}="${fe(String(e.attrs[t][1]))}"`;
    return o;
  }
  /**
  * Default token renderer. Can be overriden by custom function
  * in {@link Renderer.rules}.
  */
  renderToken(e, t, n) {
    let o = e[t], r = "";
    if (o.hidden) return "";
    let i = t - 1;
    for (; i >= 0 && e[i].hidden && e[i].nesting === 0; ) i--;
    o.block && o.nesting !== -1 && i >= 0 && e[i].hidden && e[i].nesting === -1 && (r += `
`), r += (o.nesting === -1 ? "</" : "<") + o.tag, r += this.renderAttrs(o), o.nesting === 0 && n.xhtmlOut && (r += " /");
    let s = !1;
    if (o.block && (s = !0, o.nesting === 1)) {
      let a = t + 1;
      for (; a < e.length && e[a].hidden && e[a].nesting === 0; ) a++;
      if (a < e.length) {
        let l = e[a];
        (l.type === "inline" || l.hidden || l.nesting === -1 && l.tag === o.tag) && (s = !1);
      }
    }
    return r += s ? `>
` : ">", r;
  }
  /**
  * The same as {@link Renderer.render}, but for single token of `inline` type.
  */
  renderInline(e, t, n) {
    let o = "", r = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      typeof r[a] < "u" ? o += r[a](e, i, t, n, this) : o += this.renderToken(e, i, t);
    }
    return o;
  }
  /**
  * Special kludge for image `alt` attributes to conform CommonMark spec.
  * Don't try to use it! Spec requires to show `alt` content with stripped markup,
  * instead of simple escaping.
  */
  renderInlineAsText(e, t, n) {
    let o = "";
    for (let r = 0, i = e.length; r < i; r++) switch (e[r].type) {
      case "text":
      case "code_inline":
        o += e[r].content;
        break;
      case "image":
        o += this.renderInlineAsText(e[r].children, t, n);
        break;
      case "html_inline":
      case "html_block":
        o += e[r].content;
        break;
      case "softbreak":
      case "hardbreak":
        o += `
`;
    }
    return o;
  }
  /**
  * Takes token stream and generates HTML. Probably, you will never need to call
  * this method directly.
  */
  render(e, t, n) {
    let o = "", r = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      a === "inline" ? o += this.renderInline(e[i].children, t, n) : typeof r[a] < "u" ? o += r[a](e, i, t, n, this) : o += this.renderToken(e, i, t);
    }
    return o;
  }
}, Yi = class {
  constructor(e, t, n) {
    v(this, "tokens", []), v(this, "inlineMode", !1), v(this, "Token", Ae), this.src = e, this.env = n, this.md = t;
  }
}, Gl = /\r\n?/g, Hl = /\0/g;
function zl(e) {
  let t;
  t = e.src.replace(Gl, `
`), t = t.replace(Hl, "\uFFFD"), e.src = t;
}
function ql(e) {
  let t;
  e.inlineMode ? (t = new e.Token("inline", "", 0), t.content = e.src, t.map = [0, 1], t.children = [], e.tokens.push(t)) : e.md.block.parse(e.src, e.md, e.env, e.tokens);
}
function Wl(e) {
  let t = e.tokens, n = 0;
  for (let o = 0; o < t.length; o++)
    t[o].type !== "reference_definition" && (o !== n && (t[n] = t[o]), n++);
  t.length !== n && (t.length = n);
}
function jl(e) {
  let t = e.tokens;
  for (let n = 0, o = t.length; n < o; n++) {
    let r = t[n];
    r.type === "inline" && e.md.inline.parse(r.content, e.md, e.env, r.children);
  }
}
function $l(e) {
  return /^<a[>\s]/i.test(e);
}
function Kl(e) {
  return /^<\/a\s*>/i.test(e);
}
function Vl(e) {
  let t = e.tokens;
  if (e.md.options.linkify)
    for (let n = 0, o = t.length; n < o; n++) {
      if (t[n].type !== "inline" || !e.md.linkify.test(t[n].content)) continue;
      let r = t[n].children, i = [], s = 0;
      for (let a = r.length - 1; a >= 0; a--) {
        let l = r[a];
        if (l.type === "link_close") {
          for (a--; r[a].level !== l.level && r[a].type !== "link_open"; ) a--;
          continue;
        }
        if (l.type === "html_inline" && ($l(l.content) && s > 0 && s--, Kl(l.content) && s++), !(s > 0) && l.type === "text" && e.md.linkify.test(l.content)) {
          let u = l.content, h = e.md.linkify.match(u), p = [], g = l.level, c = 0;
          h.length > 0 && h[0].index === 0 && a > 0 && r[a - 1].type === "text_special" && (h = h.slice(1));
          for (let d = 0; d < h.length; d++) {
            let m = h[d].url, f = e.md.normalizeLink(m);
            if (!e.md.validateLink(f)) continue;
            let y = h[d].text;
            h[d].schema ? h[d].schema === "mailto:" && !/^mailto:/i.test(y) ? y = e.md.normalizeLinkText(`mailto:${y}`).replace(/^mailto:/, "") : y = e.md.normalizeLinkText(y) : y = e.md.normalizeLinkText(`http://${y}`).replace(/^http:\/\//, "");
            let w = h[d].index;
            if (w > c) {
              let R = new e.Token("text", "", 0);
              R.content = u.slice(c, w), R.level = g, p.push(R);
            }
            let b = new e.Token("link_open", "a", 1);
            b.attrs = [["href", f]], b.level = g++, b.markup = "linkify", b.info = "auto", p.push(b);
            let S = new e.Token("text", "", 0);
            S.content = y, S.level = g, p.push(S);
            let k = new e.Token("link_close", "a", -1);
            k.level = --g, k.markup = "linkify", k.info = "auto", p.push(k), c = h[d].lastIndex;
          }
          if (c < u.length) {
            let d = new e.Token("text", "", 0);
            d.content = u.slice(c), d.level = g, p.push(d);
          }
          i.push({
            index: a,
            nodes: p
          });
        }
      }
      if (i.length > 0) {
        let a = r.length;
        for (let p of i) a += p.nodes.length - 1;
        let l = new Array(a), u = 0, h = 0;
        i.reverse();
        for (let p = 0; p < r.length; p++) {
          let g = i[u];
          if (g?.index === p) {
            for (let c of g.nodes) l[h++] = c;
            u++;
          } else l[h++] = r[p];
        }
        t[n].children = l;
      }
    }
}
var Zi = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/, Yl = /\((c|tm|r)\)/i, Zl = /\((c|tm|r)\)/gi, Jl = {
  c: "\xA9",
  r: "\xAE",
  tm: "\u2122"
};
function Xl(e, t) {
  return Jl[t.toLowerCase()];
}
function Ql(e) {
  let t = 0;
  for (let n = e.length - 1; n >= 0; n--) {
    let o = e[n];
    o.type === "text" && !t && (o.content = o.content.replace(Zl, Xl)), o.type === "link_open" && o.info === "auto" && t--, o.type === "link_close" && o.info === "auto" && t++;
  }
}
function ed(e) {
  let t = 0;
  for (let n = e.length - 1; n >= 0; n--) {
    let o = e[n];
    o.type === "text" && !t && Zi.test(o.content) && (o.content = o.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013")), o.type === "link_open" && o.info === "auto" && t--, o.type === "link_close" && o.info === "auto" && t++;
  }
}
function td(e) {
  let t;
  if (e.md.options.typographer)
    for (t = e.tokens.length - 1; t >= 0; t--)
      e.tokens[t].type === "inline" && (Yl.test(e.tokens[t].content) && Ql(e.tokens[t].children), Zi.test(e.tokens[t].content) && ed(e.tokens[t].children));
}
var nd = /['"]/, Oi = /['"]/g, Ni = "\u2019", rd = 1e3;
function Ui(e, t, n) {
  for (; e.length > n; ) {
    let o = e.pop();
    o.isSingleQuote ? t.single = o.prevSameQuoteIdx : t.double = o.prevSameQuoteIdx;
  }
}
function Nt(e, t, n, o) {
  e[t] || (e[t] = []), e[t].push({
    pos: n,
    ch: o
  });
}
function od(e, t) {
  let n = "", o = 0;
  t.sort((r, i) => r.pos - i.pos);
  for (let r = 0; r < t.length; r++) {
    let i = t[r];
    n += e.slice(o, i.pos) + i.ch, o = i.pos + 1;
  }
  return n + e.slice(o);
}
function id(e, t) {
  let n, o = [], r = {
    single: -1,
    double: -1
  }, i = {};
  for (let s = 0; s < e.length; s++) {
    let a = e[s], l = e[s].level;
    for (n = o.length - 1; n >= 0 && !(o[n].level <= l); n--) ;
    if (Ui(o, r, n + 1), a.type !== "text") continue;
    let u = a.content, h = 0, p = u.length;
    e: for (; h < p; ) {
      Oi.lastIndex = h;
      let g = Oi.exec(u);
      if (!g) break;
      let c = !0, d = !0;
      h = g.index + 1;
      let m = g[0] === "'", f = 32;
      if (g.index - 1 >= 0) f = u.charCodeAt(g.index - 1);
      else for (n = s - 1; n >= 0 && !(e[n].type === "softbreak" || e[n].type === "hardbreak"); n--)
        if (e[n].content) {
          f = e[n].content.charCodeAt(e[n].content.length - 1);
          break;
        }
      let y = 32;
      if (h < p) y = u.charCodeAt(h);
      else for (n = s + 1; n < e.length && !(e[n].type === "softbreak" || e[n].type === "hardbreak"); n++)
        if (e[n].content) {
          y = e[n].content.charCodeAt(0);
          break;
        }
      let w = et(f) || Qe(f), b = et(y) || Qe(y), S = Xe(f), k = Xe(y);
      if (k ? c = !1 : b && (S || w || (c = !1)), S ? d = !1 : w && (k || b || (d = !1)), y === 34 && g[0] === '"' && f >= 48 && f <= 57 && (d = c = !1), c && d && (c = w, d = b), !c && !d) {
        m && Nt(i, s, g.index, Ni);
        continue;
      }
      if (d && (n = m ? r.single : r.double, n >= 0 && o[n].level === l)) {
        let R = o[n], I, E;
        m ? (I = t.md.options.quotes[2], E = t.md.options.quotes[3]) : (I = t.md.options.quotes[0], E = t.md.options.quotes[1]), Nt(i, s, g.index, E), Nt(i, R.tokenIdx, R.contentPos, I), Ui(o, r, n);
        continue e;
      }
      if (c) {
        if (o.length >= rd) return;
        o.push({
          tokenIdx: s,
          contentPos: g.index,
          isSingleQuote: m,
          level: l,
          prevSameQuoteIdx: m ? r.single : r.double
        }), m ? r.single = o.length - 1 : r.double = o.length - 1;
      } else d && m && Nt(i, s, g.index, Ni);
    }
  }
  Object.keys(i).forEach(function(s) {
    let a = Number(s);
    e[a].content = od(e[a].content, i[s]);
  });
}
function sd(e) {
  if (e.md.options.typographer)
    for (let t = e.tokens.length - 1; t >= 0; t--)
      e.tokens[t].type !== "inline" || !nd.test(e.tokens[t].content) || id(e.tokens[t].children, e);
}
function ad(e) {
  let t, n, o = e.length;
  for (t = 0; t < o; t++) e[t].type === "text_special" && (e[t].type = "text");
  for (t = n = 0; t < o; t++) e[t].type === "text" && t + 1 < o && e[t + 1].type === "text" ? e[t + 1].content = e[t].content + e[t + 1].content : (t !== n && (e[n] = e[t]), n++);
  t !== n && (e.length = n);
}
function cd(e) {
  let t, n, o = e.tokens, r = o.length;
  for (let i = 0; i < r; i++) {
    if (o[i].type !== "inline") continue;
    let s = o[i].children, a = s.length;
    for (t = 0; t < a; t++)
      s[t].type === "text_special" && (s[t].type = "text"), s[t].children && ad(s[t].children);
    for (t = n = 0; t < a; t++) s[t].type === "text" && t + 1 < a && s[t + 1].type === "text" ? s[t + 1].content = s[t].content + s[t + 1].content : (t !== n && (s[n] = s[t]), n++);
    t !== n && (s.length = n);
  }
}
var Dn = [
  ["normalize", zl],
  ["block", ql],
  ["strip_references", Wl],
  ["inline", jl],
  ["linkify", Vl],
  ["replacements", td],
  ["smartquotes", sd],
  ["text_join", cd]
], Ji = class {
  constructor() {
    v(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of core rules.
      */
      "ruler",
      new nt()
    ), v(this, "State", Yi);
    for (let e = 0; e < Dn.length; e++) this.ruler.push(Dn[e][0], Dn[e][1]);
  }
  /**
  * Executes core chain rules.
  */
  process(e) {
    let t = this.ruler.getRules("");
    for (let n = 0, o = t.length; n < o; n++) t[n](e);
  }
}, Xi = class {
  constructor(e, t, n, o) {
    v(this, "bMarks", []), v(this, "eMarks", []), v(this, "tShift", []), v(this, "sCount", []), v(this, "bsCount", []), v(this, "blkIndent", 0), v(this, "line", 0), v(this, "lineMax", 0), v(this, "tight", !1), v(this, "listIndent", -1), v(this, "parentType", "root"), v(this, "level", 0), v(this, "Token", Ae), this.src = e, this.md = t, this.env = n, this.tokens = o;
    let r = this.src;
    for (let i = 0, s = 0, a = 0, l = 0, u = r.length, h = !1; s < u; s++) {
      let p = r.charCodeAt(s);
      if (!h) if (N(p)) {
        a++, p === 9 ? l += 4 - l % 4 : l++;
        continue;
      } else h = !0;
      (p === 10 || s === u - 1) && (p !== 10 && s++, this.bMarks.push(i), this.eMarks.push(s), this.tShift.push(a), this.sCount.push(l), this.bsCount.push(0), h = !1, a = 0, l = 0, i = s + 1);
    }
    this.bMarks.push(r.length), this.eMarks.push(r.length), this.tShift.push(0), this.sCount.push(0), this.bsCount.push(0), this.lineMax = this.bMarks.length - 1;
  }
  push(e, t, n) {
    let o = new Ae(e, t, n);
    return o.block = !0, n < 0 && this.level--, o.level = this.level, n > 0 && this.level++, this.tokens.push(o), o;
  }
  isEmpty(e) {
    return this.bMarks[e] + this.tShift[e] >= this.eMarks[e];
  }
  skipEmptyLines(e) {
    for (let t = this.lineMax; e < t && !(this.bMarks[e] + this.tShift[e] < this.eMarks[e]); e++) ;
    return e;
  }
  skipSpaces(e) {
    for (let t = this.src.length; e < t && N(this.src.charCodeAt(e)); e++) ;
    return e;
  }
  skipSpacesBack(e, t) {
    if (e <= t) return e;
    for (; e > t; ) if (!N(this.src.charCodeAt(--e))) return e + 1;
    return e;
  }
  skipChars(e, t) {
    for (let n = this.src.length; e < n && this.src.charCodeAt(e) === t; e++) ;
    return e;
  }
  skipCharsBack(e, t, n) {
    if (e <= n) return e;
    for (; e > n; ) if (t !== this.src.charCodeAt(--e)) return e + 1;
    return e;
  }
  getLines(e, t, n, o) {
    if (e >= t) return "";
    let r = new Array(t - e);
    for (let i = 0, s = e; s < t; s++, i++) {
      let a = 0, l = this.bMarks[s], u = l, h;
      for (s + 1 < t || o ? h = this.eMarks[s] + 1 : h = this.eMarks[s]; u < h && a < n; ) {
        let p = this.src.charCodeAt(u);
        if (N(p)) p === 9 ? a += 4 - (a + this.bsCount[s]) % 4 : a++;
        else if (u - l < this.tShift[s]) a++;
        else break;
        u++;
      }
      a > n ? r[i] = new Array(a - n + 1).join(" ") + this.src.slice(u, h) : r[i] = this.src.slice(u, h);
    }
    return r.join("");
  }
}, ld = 65536;
function Mn(e, t) {
  let n = e.bMarks[t] + e.tShift[t], o = e.eMarks[t];
  return e.src.slice(n, o);
}
function Fi(e) {
  let t = [], n = e.length, o = 0, r = e.charCodeAt(o), i = !1, s = 0, a = "";
  for (; o < n; )
    r === 124 && (i ? (a += e.substring(s, o - 1), s = o) : (t.push(a + e.substring(s, o)), a = "", s = o + 1)), i = r === 92, o++, r = e.charCodeAt(o);
  return t.push(a + e.substring(s)), t;
}
function dd(e, t, n, o) {
  if (t + 2 > n) return !1;
  let r = t + 1;
  if (e.sCount[r] < e.blkIndent || e.sCount[r] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[r] + e.tShift[r];
  if (i >= e.eMarks[r]) return !1;
  let s = e.src.charCodeAt(i++);
  if (s !== 124 && s !== 45 && s !== 58 || i >= e.eMarks[r]) return !1;
  let a = e.src.charCodeAt(i++);
  if (a !== 124 && a !== 45 && a !== 58 && !N(a) || s === 45 && N(a)) return !1;
  for (; i < e.eMarks[r]; ) {
    let S = e.src.charCodeAt(i);
    if (S !== 124 && S !== 45 && S !== 58 && !N(S)) return !1;
    i++;
  }
  let l = Mn(e, t + 1), u = l.split("|"), h = [];
  for (let S = 0; S < u.length; S++) {
    let k = u[S].trim();
    if (!k) {
      if (S === 0 || S === u.length - 1) continue;
      return !1;
    }
    if (!/^:?-+:?$/.test(k)) return !1;
    k.charCodeAt(k.length - 1) === 58 ? h.push(k.charCodeAt(0) === 58 ? "center" : "right") : k.charCodeAt(0) === 58 ? h.push("left") : h.push("");
  }
  if (l = Mn(e, t).trim(), l.indexOf("|") === -1 || e.sCount[t] - e.blkIndent >= 4) return !1;
  u = Fi(l), u.length && u[0] === "" && u.shift(), u.length && u[u.length - 1] === "" && u.pop();
  let p = u.length;
  if (p === 0 || p !== h.length) return !1;
  if (o) return !0;
  let g = e.parentType;
  e.parentType = "table";
  let c = e.md.block.ruler.getRules("blockquote"), d = e.push("table_open", "table", 1), m = [t, 0];
  d.map = m;
  let f = e.push("thead_open", "thead", 1);
  f.map = [t, t + 1];
  let y = e.push("tr_open", "tr", 1);
  y.map = [t, t + 1];
  for (let S = 0; S < u.length; S++) {
    let k = e.push("th_open", "th", 1);
    h[S] && (k.attrs = [["style", `text-align:${h[S]}`]]);
    let R = e.push("inline", "", 0);
    R.content = u[S].trim(), R.children = [], e.push("th_close", "th", -1);
  }
  e.push("tr_close", "tr", -1), e.push("thead_close", "thead", -1);
  let w, b = 0;
  for (r = t + 2; r < n && !(e.sCount[r] < e.blkIndent); r++) {
    let S = !1;
    for (let R = 0, I = c.length; R < I; R++) if (c[R](e, r, n, !0)) {
      S = !0;
      break;
    }
    if (S || (l = Mn(e, r).trim(), !l) || e.sCount[r] - e.blkIndent >= 4 || (u = Fi(l), u.length && u[0] === "" && u.shift(), u.length && u[u.length - 1] === "" && u.pop(), b += p - u.length, b > ld)) break;
    if (r === t + 2) {
      let R = e.push("tbody_open", "tbody", 1);
      R.map = w = [t + 2, 0];
    }
    let k = e.push("tr_open", "tr", 1);
    k.map = [r, r + 1];
    for (let R = 0; R < p; R++) {
      let I = e.push("td_open", "td", 1);
      h[R] && (I.attrs = [["style", `text-align:${h[R]}`]]);
      let E = e.push("inline", "", 0);
      E.content = u[R] ? u[R].trim() : "", E.children = [], e.push("td_close", "td", -1);
    }
    e.push("tr_close", "tr", -1);
  }
  return w && (e.push("tbody_close", "tbody", -1), w[1] = r), e.push("table_close", "table", -1), m[1] = r, e.parentType = g, e.line = r, !0;
}
function ud(e, t, n) {
  if (e.sCount[t] - e.blkIndent < 4) return !1;
  let o = t + 1, r = o;
  for (; o < n; ) {
    if (e.isEmpty(o)) {
      o++;
      continue;
    }
    if (e.sCount[o] - e.blkIndent >= 4) {
      o++, r = o;
      continue;
    }
    break;
  }
  e.line = r;
  let i = e.push("code_block", "code", 0);
  return i.content = e.getLines(t, r, 4 + e.blkIndent, !1) + `
`, i.map = [t, e.line], !0;
}
function pd(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4 || r + 3 > i) return !1;
  let s = e.src.charCodeAt(r);
  if (s !== 126 && s !== 96) return !1;
  let a = r;
  r = e.skipChars(r, s);
  let l = r - a;
  if (l < 3) return !1;
  let u = e.src.slice(a, r), h = e.src.slice(r, i);
  if (s === 96 && h.indexOf(String.fromCharCode(s)) >= 0)
    return !1;
  if (o) return !0;
  let p = t, g = !1;
  for (; p++, !(p >= n || (r = a = e.bMarks[p] + e.tShift[p], i = e.eMarks[p], r < i && e.sCount[p] < e.blkIndent)); )
    if (e.src.charCodeAt(r) === s && !(e.sCount[p] - e.blkIndent >= 4) && (r = e.skipChars(r, s), !(r - a < l) && (r = e.skipSpaces(r), !(r < i)))) {
      g = !0;
      break;
    }
  l = e.sCount[t], e.line = p + (g ? 1 : 0);
  let c = e.push("fence", "code", 0);
  return c.info = h, c.content = e.getLines(t + 1, p, l, !0), c.markup = u, c.map = [t, e.line], !0;
}
function fd(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t], s = e.lineMax;
  if (e.sCount[t] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 62) return !1;
  if (o) return !0;
  let a = [], l = [], u = [], h = [], p = e.md.block.ruler.getRules("blockquote"), g = e.parentType;
  e.parentType = "blockquote";
  let c = !1, d;
  for (d = t; d < n; d++) {
    let b = e.sCount[d] < e.blkIndent;
    if (r = e.bMarks[d] + e.tShift[d], i = e.eMarks[d], r >= i) break;
    if (e.src.charCodeAt(r++) === 62 && !b) {
      let k = e.sCount[d] + 1, R, I;
      e.src.charCodeAt(r) === 32 ? (r++, k++, I = !1, R = !0) : e.src.charCodeAt(r) === 9 ? (R = !0, (e.bsCount[d] + k) % 4 === 3 ? (r++, k++, I = !1) : I = !0) : R = !1;
      let E = k;
      for (a.push(e.bMarks[d]), e.bMarks[d] = r; r < i; ) {
        let T = e.src.charCodeAt(r);
        if (N(T)) T === 9 ? E += 4 - (E + e.bsCount[d] + (I ? 1 : 0)) % 4 : E++;
        else break;
        r++;
      }
      c = r >= i, l.push(e.bsCount[d]), e.bsCount[d] = e.sCount[d] + 1 + (R ? 1 : 0), u.push(e.sCount[d]), e.sCount[d] = E - k, h.push(e.tShift[d]), e.tShift[d] = r - e.bMarks[d];
      continue;
    }
    if (c) break;
    let S = !1;
    for (let k = 0, R = p.length; k < R; k++) if (p[k](e, d, n, !0)) {
      S = !0;
      break;
    }
    if (S) {
      e.lineMax = d, e.blkIndent !== 0 && (a.push(e.bMarks[d]), l.push(e.bsCount[d]), h.push(e.tShift[d]), u.push(e.sCount[d]), e.sCount[d] -= e.blkIndent);
      break;
    }
    a.push(e.bMarks[d]), l.push(e.bsCount[d]), h.push(e.tShift[d]), u.push(e.sCount[d]), e.sCount[d] = -1;
  }
  let m = e.blkIndent;
  e.blkIndent = 0;
  let f = e.push("blockquote_open", "blockquote", 1);
  f.markup = ">";
  let y = [t, 0];
  f.map = y, e.md.block.tokenize(e, t, d);
  let w = e.push("blockquote_close", "blockquote", -1);
  w.markup = ">", e.lineMax = s, e.parentType = g, y[1] = e.line;
  for (let b = 0; b < h.length; b++)
    e.bMarks[b + t] = a[b], e.tShift[b + t] = h[b], e.sCount[b + t] = u[b], e.bsCount[b + t] = l[b];
  return e.blkIndent = m, !0;
}
function hd(e, t, n, o) {
  let r = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[t] + e.tShift[t], s = e.src.charCodeAt(i++);
  if (s !== 42 && s !== 45 && s !== 95) return !1;
  let a = 1;
  for (; i < r; ) {
    let u = e.src.charCodeAt(i++);
    if (u !== s && !N(u)) return !1;
    u === s && a++;
  }
  if (a < 3) return !1;
  if (o) return !0;
  e.line = t + 1;
  let l = e.push("hr", "hr", 0);
  return l.map = [t, e.line], l.markup = Array(a + 1).join(String.fromCharCode(s)), !0;
}
function Li(e, t) {
  let n = e.eMarks[t], o = e.bMarks[t] + e.tShift[t], r = e.src.charCodeAt(o++);
  return r !== 42 && r !== 45 && r !== 43 || o < n && !N(e.src.charCodeAt(o)) ? -1 : o;
}
function Bi(e, t) {
  let n = e.bMarks[t] + e.tShift[t], o = e.eMarks[t], r = n;
  if (r + 1 >= o) return -1;
  let i = e.src.charCodeAt(r++);
  if (i < 48 || i > 57) return -1;
  for (; ; ) {
    if (r >= o) return -1;
    if (i = e.src.charCodeAt(r++), i >= 48 && i <= 57) {
      if (r - n >= 10) return -1;
      continue;
    }
    if (i === 41 || i === 46) break;
    return -1;
  }
  return r < o && (i = e.src.charCodeAt(r), !N(i)) ? -1 : r;
}
function gd(e, t) {
  let n = e.level + 2;
  for (let o = t + 2, r = e.tokens.length - 2; o < r; o++) e.tokens[o].level === n && e.tokens[o].type === "paragraph_open" && (e.tokens[o + 2].hidden = !0, e.tokens[o].hidden = !0, o += 2);
}
function md(e, t, n, o) {
  let r, i, s, a, l = t, u = !0;
  if (e.sCount[l] - e.blkIndent >= 4 || e.listIndent >= 0 && e.sCount[l] - e.listIndent >= 4 && e.sCount[l] < e.blkIndent) return !1;
  let h = !1;
  o && e.parentType === "paragraph" && e.sCount[l] >= e.blkIndent && (h = !0);
  let p, g, c;
  if ((c = Bi(e, l)) >= 0) {
    if (p = !0, s = e.bMarks[l] + e.tShift[l], g = Number(e.src.slice(s, c - 1)), h && g !== 1) return !1;
  } else if ((c = Li(e, l)) >= 0) p = !1;
  else return !1;
  if (h && e.skipSpaces(c) >= e.eMarks[l])
    return !1;
  if (o) return !0;
  let d = e.src.charCodeAt(c - 1), m = e.tokens.length;
  p ? (a = e.push("ordered_list_open", "ol", 1), g !== 1 && (a.attrs = [["start", g]])) : a = e.push("bullet_list_open", "ul", 1);
  let f = [l, 0];
  a.map = f, a.markup = String.fromCharCode(d);
  let y = !1, w = e.md.block.ruler.getRules("list"), b = e.parentType;
  for (e.parentType = "list"; l < n; ) {
    i = c, r = e.eMarks[l];
    let S = e.sCount[l] + c - (e.bMarks[l] + e.tShift[l]), k = S;
    for (; i < r; ) {
      let j = e.src.charCodeAt(i);
      if (j === 9) k += 4 - (k + e.bsCount[l]) % 4;
      else if (j === 32) k++;
      else break;
      i++;
    }
    let R = i, I;
    R >= r ? I = 1 : I = k - S, I > 4 && (I = 1);
    let E = S + I;
    a = e.push("list_item_open", "li", 1), a.markup = String.fromCharCode(d);
    let T = [l, 0];
    a.map = T, p && (a.info = e.src.slice(s, c - 1));
    let M = e.tight, _ = e.tShift[l], A = e.sCount[l], q = e.listIndent;
    if (e.listIndent = e.blkIndent, e.blkIndent = E, e.tight = !0, e.tShift[l] = R - e.bMarks[l], e.sCount[l] = k, R >= r && e.isEmpty(l + 1) ? e.line = Math.min(e.line + 2, n) : e.md.block.tokenize(e, l, n), (!e.tight || y) && (u = !1), y = e.line - l > 1 && e.isEmpty(e.line - 1), e.blkIndent = e.listIndent, e.listIndent = q, e.tShift[l] = _, e.sCount[l] = A, e.tight = M, a = e.push("list_item_close", "li", -1), a.markup = String.fromCharCode(d), l = e.line, T[1] = l, l >= n || e.sCount[l] < e.blkIndent || e.sCount[l] - e.blkIndent >= 4) break;
    let K = !1;
    for (let j = 0, xs = w.length; j < xs; j++) if (w[j](e, l, n, !0)) {
      K = !0;
      break;
    }
    if (K) break;
    if (p) {
      if (c = Bi(e, l), c < 0) break;
      s = e.bMarks[l] + e.tShift[l];
    } else if (c = Li(e, l), c < 0) break;
    if (d !== e.src.charCodeAt(c - 1)) break;
  }
  return p ? a = e.push("ordered_list_close", "ol", -1) : a = e.push("bullet_list_close", "ul", -1), a.markup = String.fromCharCode(d), f[1] = l, e.line = l, e.parentType = b, u && gd(e, m), !0;
}
function yd(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t], s = t + 1;
  if (e.sCount[t] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 91) return !1;
  function a(S) {
    let k = e.lineMax;
    if (S >= k || e.isEmpty(S)) return null;
    let R = !1;
    if (e.sCount[S] - e.blkIndent > 3 && (R = !0), e.sCount[S] < 0 && (R = !0), !R) {
      let T = e.md.block.ruler.getRules("reference"), M = e.parentType;
      e.parentType = "reference";
      let _ = !1;
      for (let A = 0, q = T.length; A < q; A++) if (T[A](e, S, k, !0)) {
        _ = !0;
        break;
      }
      if (e.parentType = M, _) return null;
    }
    let I = e.bMarks[S] + e.tShift[S], E = e.eMarks[S];
    return e.src.slice(I, E + 1);
  }
  let l = e.src.slice(r, i + 1);
  i = l.length;
  let u = -1;
  for (r = 1; r < i; r++) {
    let S = l.charCodeAt(r);
    if (S === 91) return !1;
    if (S === 93) {
      u = r;
      break;
    } else if (S === 10) {
      let k = a(s);
      k !== null && (l += k, i = l.length, s++);
    } else if (S === 92 && (r++, r < i && l.charCodeAt(r) === 10)) {
      let k = a(s);
      k !== null && (l += k, i = l.length, s++);
    }
  }
  if (u < 0 || l.charCodeAt(u + 1) !== 58) return !1;
  for (r = u + 2; r < i; r++) {
    let S = l.charCodeAt(r);
    if (S === 10) {
      let k = a(s);
      k !== null && (l += k, i = l.length, s++);
    } else if (!N(S))
      break;
  }
  let h = e.md.helpers.parseLinkDestination(l, r, i);
  if (!h.ok) return !1;
  let p = e.md.normalizeLink(h.str);
  if (!e.md.validateLink(p)) return !1;
  r = h.pos;
  let g = r, c = s, d = r;
  for (; r < i; r++) {
    let S = l.charCodeAt(r);
    if (S === 10) {
      let k = a(s);
      k !== null && (l += k, i = l.length, s++);
    } else if (!N(S))
      break;
  }
  let m = e.md.helpers.parseLinkTitle(l, r, i);
  for (; m.can_continue; ) {
    let S = a(s);
    if (S === null) break;
    l += S, r = i, i = l.length, s++, m = e.md.helpers.parseLinkTitle(l, r, i, m);
  }
  let f;
  for (r < i && d !== r && m.ok ? (f = m.str, r = m.pos) : (f = "", r = g, s = c); r < i && N(l.charCodeAt(r)); )
    r++;
  if (r < i && l.charCodeAt(r) !== 10 && f)
    for (f = "", r = g, s = c; r < i && N(l.charCodeAt(r)); )
      r++;
  if (r < i && l.charCodeAt(r) !== 10) return !1;
  let y = Ft(l.slice(1, u));
  if (!y) return !1;
  if (o) return !0;
  typeof e.env.references > "u" && (e.env.references = {}), typeof e.env.references[y] > "u" && (e.env.references[y] = {
    title: f,
    href: p
  });
  let w = e.push("reference_definition", "", 0);
  w.map = [t, s], w.hidden = !0;
  let b = /* @__PURE__ */ Object.create(null);
  return b.label = y, w.meta = b, e.line = s, !0;
}
var wd = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
], Qi = `<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`, es = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>", bd = new RegExp(`^(?:${Qi}|${es}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`), Sd = new RegExp(`^(?:${Qi}|${es})`), Ee = [
  [
    /^<(script|pre|style|textarea)(?=(\s|>|$))/i,
    /<\/(script|pre|style|textarea)>/i,
    !0
  ],
  [
    /^<!--/,
    /-->/,
    !0
  ],
  [
    /^<\?/,
    /\?>/,
    !0
  ],
  [
    /^<![A-Za-z]/,
    />/,
    !0
  ],
  [
    /^<!\[CDATA\[/,
    /\]\]>/,
    !0
  ],
  [
    new RegExp(`^</?(${wd.join("|")})(?=(\\s|/?>|$))`, "i"),
    /^$/,
    !0
  ],
  [
    new RegExp(`${Sd.source}\\s*$`),
    /^$/,
    !1
  ]
];
function kd(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4 || !e.md.options.html || e.src.charCodeAt(r) !== 60) return !1;
  let s = e.src.slice(r, i), a = 0;
  for (; a < Ee.length && !Ee[a][0].test(s); a++) ;
  if (a === Ee.length) return !1;
  if (o) return Ee[a][2];
  let l = t + 1, u = Ee[a][1].test("");
  if (!Ee[a][1].test(s)) {
    for (; l < n && !(e.sCount[l] < e.blkIndent && (u || !e.isEmpty(l))); l++)
      if (r = e.bMarks[l] + e.tShift[l], i = e.eMarks[l], s = e.src.slice(r, i), Ee[a][1].test(s)) {
        s.length !== 0 && l++;
        break;
      }
  }
  e.line = l;
  let h = e.push("html_block", "", 0);
  return h.map = [t, l], h.content = e.getLines(t, l, e.blkIndent, !0), !0;
}
function Rd(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let s = e.src.charCodeAt(r);
  if (s !== 35 || r >= i) return !1;
  let a = 1;
  for (s = e.src.charCodeAt(++r); s === 35 && r < i && a <= 6; )
    a++, s = e.src.charCodeAt(++r);
  if (a > 6 || r < i && !N(s)) return !1;
  if (o) return !0;
  i = e.skipSpacesBack(i, r);
  let l = e.skipCharsBack(i, 35, r);
  l > r && N(e.src.charCodeAt(l - 1)) && (i = l), e.line = t + 1;
  let u = e.push("heading_open", `h${a}`, 1);
  u.markup = "########".slice(0, a), u.map = [t, e.line];
  let h = e.push("inline", "", 0);
  h.content = Lt(e.src.slice(r, i)), h.map = [t, e.line], h.children = [];
  let p = e.push("heading_close", `h${a}`, -1);
  return p.markup = "########".slice(0, a), !0;
}
function xd(e, t, n) {
  let o = e.md.block.ruler.getRules("paragraph");
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let r = e.parentType;
  e.parentType = "paragraph";
  let i = 0, s, a = t + 1;
  for (; a < n && !e.isEmpty(a); a++) {
    if (e.sCount[a] - e.blkIndent > 3) continue;
    if (e.sCount[a] >= e.blkIndent) {
      let c = e.bMarks[a] + e.tShift[a], d = e.eMarks[a];
      if (c < d && (s = e.src.charCodeAt(c), (s === 45 || s === 61) && (c = e.skipChars(c, s), c = e.skipSpaces(c), c >= d))) {
        i = s === 61 ? 1 : 2;
        break;
      }
    }
    if (e.sCount[a] < 0) continue;
    let g = !1;
    for (let c = 0, d = o.length; c < d; c++) if (o[c](e, a, n, !0)) {
      g = !0;
      break;
    }
    if (g) break;
  }
  if (!i)
    return e.parentType = r, !1;
  let l = Lt(e.getLines(t, a, e.blkIndent, !1));
  e.line = a + 1;
  let u = e.push("heading_open", `h${i}`, 1);
  u.markup = String.fromCharCode(s), u.map = [t, e.line];
  let h = e.push("inline", "", 0);
  h.content = l, h.map = [t, e.line - 1], h.children = [];
  let p = e.push("heading_close", `h${i}`, -1);
  return p.markup = String.fromCharCode(s), e.parentType = r, !0;
}
function vd(e, t, n) {
  let o = e.md.block.ruler.getRules("paragraph"), r = e.parentType, i = t + 1;
  for (e.parentType = "paragraph"; i < n && !e.isEmpty(i); i++) {
    if (e.sCount[i] - e.blkIndent > 3 || e.sCount[i] < 0) continue;
    let u = !1;
    for (let h = 0, p = o.length; h < p; h++) if (o[h](e, i, n, !0)) {
      u = !0;
      break;
    }
    if (u) break;
  }
  let s = Lt(e.getLines(t, i, e.blkIndent, !1));
  e.line = i;
  let a = e.push("paragraph_open", "p", 1);
  a.map = [t, e.line];
  let l = e.push("inline", "", 0);
  return l.content = s, l.map = [t, e.line], l.children = [], e.push("paragraph_close", "p", -1), e.parentType = r, !0;
}
var Ut = [
  [
    "table",
    dd,
    ["paragraph", "reference"]
  ],
  ["code", ud],
  [
    "fence",
    pd,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "blockquote",
    fd,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "hr",
    hd,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "list",
    md,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["reference", yd],
  [
    "html_block",
    kd,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  [
    "heading",
    Rd,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["lheading", xd],
  ["paragraph", vd]
], ts = class {
  constructor() {
    v(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of block rules.
      */
      "ruler",
      new nt()
    ), v(this, "State", Xi);
    for (let e = 0; e < Ut.length; e++) this.ruler.push(Ut[e][0], Ut[e][1], { alt: (Ut[e][2] || []).slice() });
  }
  tokenize(e, t, n) {
    let o = this.ruler.getRules(""), r = o.length, i = e.md.options.maxNesting, s = t, a = !1;
    for (; s < n && (e.line = s = e.skipEmptyLines(s), !(s >= n || e.sCount[s] < e.blkIndent)); ) {
      if (e.level >= i) {
        e.line = n;
        break;
      }
      let l = e.line, u = !1;
      for (let h = 0; h < r; h++)
        if (u = o[h](e, s, n, !1), u) {
          if (l >= e.line) throw new Error("block rule didn't increment state.line");
          break;
        }
      if (!u) throw new Error("none of the block rules matched");
      e.tight = !a, e.isEmpty(e.line - 1) && (a = !0), s = e.line, s < n && e.isEmpty(s) && (a = !0, s++, e.line = s);
    }
  }
  /**
  * Process input string and push block tokens into `outTokens`
  */
  parse(e, t, n, o) {
    if (!e) return;
    let r = new this.State(e, t, n, o);
    this.tokenize(r, r.line, r.lineMax);
  }
}, ns = class {
  constructor(e, t, n, o) {
    v(this, "pos", 0), v(this, "level", 0), v(this, "pending", ""), v(this, "pendingLevel", 0), v(this, "cache", {}), v(this, "backticks", {}), v(this, "backticksScanned", !1), v(this, "linkLevel", 0), v(this, "delimiters", []), v(this, "_prev_delimiters", []), v(this, "Token", Ae), this.src = e, this.env = n, this.md = t, this.tokens = o, this.tokens_meta = Array(o.length), this.posMax = this.src.length;
  }
  pushPending() {
    let e = new Ae("text", "", 0);
    return e.content = this.pending, e.level = this.pendingLevel, this.tokens.push(e), this.pending = "", e;
  }
  push(e, t, n) {
    this.pending && this.pushPending();
    let o = new Ae(e, t, n), r;
    return n < 0 && (this.level--, this.delimiters = this._prev_delimiters.pop()), o.level = this.level, n > 0 && (this.level++, this._prev_delimiters.push(this.delimiters), this.delimiters = [], r = { delimiters: this.delimiters }), this.pendingLevel = this.level, this.tokens.push(o), this.tokens_meta.push(r), o;
  }
  scanDelims(e, t) {
    let n = this.posMax, o = this.src.charCodeAt(e), r;
    if (e === 0) r = 32;
    else if (e === 1)
      r = this.src.charCodeAt(0), (r & 63488) === 55296 && (r = 65533);
    else if (r = this.src.charCodeAt(e - 1), (r & 64512) === 56320) {
      let d = this.src.charCodeAt(e - 2);
      r = (d & 64512) === 55296 ? 65536 + (d - 55296 << 10) + (r - 56320) : 65533;
    } else (r & 64512) === 55296 && (r = 65533);
    let i = e;
    for (; i < n && this.src.charCodeAt(i) === o; ) i++;
    let s = i - e, a = i < n ? this.src.charCodeAt(i) : 32;
    if ((a & 64512) === 55296) {
      let d = this.src.charCodeAt(i + 1);
      a = (d & 64512) === 56320 ? 65536 + (a - 55296 << 10) + (d - 56320) : 65533;
    } else (a & 64512) === 56320 && (a = 65533);
    let l = et(r) || Qe(r), u = et(a) || Qe(a), h = Xe(r), p = Xe(a), g = !p && (!u || h || l), c = !h && (!l || p || u);
    return {
      can_open: g && (t || !c || l),
      can_close: c && (t || !g || u),
      length: s
    };
  }
};
function Cd(e) {
  switch (e) {
    case 10:
    case 33:
    case 35:
    case 36:
    case 37:
    case 38:
    case 42:
    case 43:
    case 45:
    case 58:
    case 60:
    case 61:
    case 62:
    case 64:
    case 91:
    case 92:
    case 93:
    case 94:
    case 95:
    case 96:
    case 123:
    case 125:
    case 126:
      return !0;
    default:
      return !1;
  }
}
function Td(e, t) {
  let n = e.pos;
  for (; n < e.posMax && !Cd(e.src.charCodeAt(n)); ) n++;
  return n === e.pos ? !1 : (t || (e.pending += e.src.slice(e.pos, n)), e.pos = n, !0);
}
function Ed(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122;
}
function Ad(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122 || e >= 48 && e <= 57 || e === 43 || e === 45 || e === 46;
}
function _d(e, t) {
  if (!e.md.options.linkify || e.linkLevel > 0) return !1;
  let n = e.pos, o = e.posMax;
  if (n + 3 > o || e.src.charCodeAt(n) !== 58 || e.src.charCodeAt(n + 1) !== 47 || e.src.charCodeAt(n + 2) !== 47) return !1;
  let r = n - Math.min(10, e.pending.length, n), i = n;
  for (; i > r && Ad(e.src.charCodeAt(i - 1)); ) i--;
  if (i === n || !Ed(e.src.charCodeAt(i))) return !1;
  let s = n - i, a = e.md.linkify.matchAtStart(e.src.slice(i));
  if (!a) return !1;
  let l = a.url;
  if (l.length <= s) return !1;
  let u = l.length;
  for (; u > 0 && l.charCodeAt(u - 1) === 42; ) u--;
  u !== l.length && (l = l.slice(0, u));
  let h = e.md.normalizeLink(l);
  if (!e.md.validateLink(h)) return !1;
  if (!t) {
    e.pending = e.pending.slice(0, -s);
    let p = e.push("link_open", "a", 1);
    p.attrs = [["href", h]], p.markup = "linkify", p.info = "auto";
    let g = e.push("text", "", 0);
    g.content = e.md.normalizeLinkText(l);
    let c = e.push("link_close", "a", -1);
    c.markup = "linkify", c.info = "auto";
  }
  return e.pos += l.length - s, !0;
}
function Id(e, t) {
  let n = e.pos;
  if (e.src.charCodeAt(n) !== 10) return !1;
  let o = e.pending.length - 1, r = e.posMax;
  if (!t) if (o >= 0 && e.pending.charCodeAt(o) === 32) if (o >= 1 && e.pending.charCodeAt(o - 1) === 32) {
    let i = o - 1;
    for (; i >= 1 && e.pending.charCodeAt(i - 1) === 32; ) i--;
    e.pending = e.pending.slice(0, i), e.push("hardbreak", "br", 0);
  } else
    e.pending = e.pending.slice(0, -1), e.push("softbreak", "br", 0);
  else e.push("softbreak", "br", 0);
  for (n++; n < r && N(e.src.charCodeAt(n)); ) n++;
  return e.pos = n, !0;
}
var Ln = [];
for (let e = 0; e < 256; e++) Ln.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(e) {
  Ln[e.charCodeAt(0)] = 1;
});
function Pd(e, t) {
  let n = e.pos, o = e.posMax;
  if (e.src.charCodeAt(n) !== 92 || (n++, n >= o)) return !1;
  let r = e.src.charCodeAt(n);
  if (r === 10) {
    for (t || e.push("hardbreak", "br", 0), n++; n < o && (r = e.src.charCodeAt(n), !!N(r)); )
      n++;
    return e.pos = n, !0;
  }
  if (r === 32) {
    if (!t) {
      let a = e.push("text_special", "", 0);
      a.content = "\\", a.markup = "\\", a.info = "escape";
    }
    return e.pos = n, !0;
  }
  let i = e.src[n];
  if (r >= 55296 && r <= 56319 && n + 1 < o) {
    let a = e.src.charCodeAt(n + 1);
    a >= 56320 && a <= 57343 && (i += e.src[n + 1], n++);
  }
  let s = "\\" + i;
  if (!t) {
    let a = e.push("text_special", "", 0);
    r < 256 && Ln[r] !== 0 ? a.content = i : a.content = s, a.markup = s, a.info = "escape";
  }
  return e.pos = n + 1, !0;
}
function Dd(e) {
  let t = {}, n = 0;
  for (; (n = e.indexOf("`", n)) !== -1; ) {
    let o = n;
    for (; e.charCodeAt(++n) === 96; ) ;
    t[n - o] = o;
  }
  return t;
}
function Md(e, t) {
  var n;
  let o = e.pos;
  if (e.src.charCodeAt(o) !== 96) return !1;
  let r = e.posMax, i = o + 1;
  for (; i < r && e.src.charCodeAt(i) === 96; ) i++;
  let s = e.src.slice(o, i), a = s.length;
  if (e.backticksScanned || (e.backticks = Dd(e.src), e.backticksScanned = !0), ((n = e.backticks[a]) !== null && n !== void 0 ? n : -1) >= i) {
    let l = i, u;
    for (; (u = e.src.indexOf("`", l)) !== -1 && u < r; ) {
      for (l = u + 1; e.src.charCodeAt(l) === 96; ) l++;
      if (l > r) break;
      if (l - u === a) {
        if (!t) {
          let h = e.push("code_inline", "code", 0);
          h.markup = s;
          let p = e.src.slice(i, u).replace(/\n/g, " ");
          p.startsWith(" ") && p.endsWith(" ") && /[^ ]/.test(p) && (p = p.slice(1, -1)), h.content = p;
        }
        return e.pos = l, !0;
      }
    }
  }
  return t || (e.pending += s), e.pos = i, !0;
}
function Od(e, t) {
  let n = e.pos, o = e.src.charCodeAt(n);
  if (t || o !== 126) return !1;
  let r = e.scanDelims(e.pos, !0), i = r.length, s = String.fromCharCode(o);
  if (i < 2) return !1;
  let a;
  i % 2 && (a = e.push("text", "", 0), a.content = s, i--);
  for (let l = 0; l < i; l += 2)
    a = e.push("text", "", 0), a.content = s + s, e.delimiters.push({
      marker: o,
      length: 0,
      token: e.tokens.length - 1,
      end: -1,
      open: r.can_open,
      close: r.can_close
    });
  return e.pos += r.length, !0;
}
function Gi(e, t) {
  let n, o = [], r = t.length;
  for (let i = 0; i < r; i++) {
    let s = t[i];
    if (s.marker !== 126 || s.end === -1) continue;
    let a = t[s.end];
    n = e.tokens[s.token], n.type = "s_open", n.tag = "s", n.nesting = 1, n.markup = "~~", n.content = "", n = e.tokens[a.token], n.type = "s_close", n.tag = "s", n.nesting = -1, n.markup = "~~", n.content = "", e.tokens[a.token - 1].type === "text" && e.tokens[a.token - 1].content === "~" && o.push(a.token - 1);
  }
  for (; o.length; ) {
    let i = o.pop(), s = i + 1;
    for (; s < e.tokens.length && e.tokens[s].type === "s_close"; ) s++;
    s--, i !== s && (n = e.tokens[s], e.tokens[s] = e.tokens[i], e.tokens[i] = n);
  }
}
function Nd(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  Gi(e, e.delimiters);
  for (let r = 0; r < n; r++) {
    var o;
    let i = (o = t[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Gi(e, i);
  }
}
var rs = {
  tokenize: Od,
  postProcess: Nd
};
function Ud(e, t) {
  let n = e.pos, o = e.src.charCodeAt(n);
  if (t || o !== 95 && o !== 42) return !1;
  let r = e.scanDelims(e.pos, o === 42);
  for (let i = 0; i < r.length; i++) {
    let s = e.push("text", "", 0);
    s.content = String.fromCharCode(o), e.delimiters.push({
      marker: o,
      length: r.length,
      token: e.tokens.length - 1,
      end: -1,
      open: r.can_open,
      close: r.can_close
    });
  }
  return e.pos += r.length, !0;
}
function Hi(e, t) {
  let n = t.length;
  for (let o = n - 1; o >= 0; o--) {
    let r = t[o];
    if (r.marker !== 95 && r.marker !== 42 || r.end === -1) continue;
    let i = t[r.end], s = o > 0 && t[o - 1].end === r.end + 1 && t[o - 1].marker === r.marker && t[o - 1].token === r.token - 1 && t[r.end + 1].token === i.token + 1, a = String.fromCharCode(r.marker), l = e.tokens[r.token];
    l.type = s ? "strong_open" : "em_open", l.tag = s ? "strong" : "em", l.nesting = 1, l.markup = s ? a + a : a, l.content = "";
    let u = e.tokens[i.token];
    u.type = s ? "strong_close" : "em_close", u.tag = s ? "strong" : "em", u.nesting = -1, u.markup = s ? a + a : a, u.content = "", s && (e.tokens[t[o - 1].token].content = "", e.tokens[t[r.end + 1].token].content = "", o--);
  }
}
function Fd(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  Hi(e, e.delimiters);
  for (let r = 0; r < n; r++) {
    var o;
    let i = (o = t[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Hi(e, i);
  }
}
var os = {
  tokenize: Ud,
  postProcess: Fd
};
function Ld(e, t) {
  let n, o, r, i, s = "", a = "", l = e.pos, u = !0;
  if (e.src.charCodeAt(e.pos) !== 91) return !1;
  let h = e.pos, p = e.posMax, g = e.pos + 1, c = e.md.helpers.parseLinkLabel(e, e.pos, !0);
  if (c < 0) return !1;
  let d = c + 1;
  if (d < p && e.src.charCodeAt(d) === 40) {
    for (u = !1, d++; d < p && (n = e.src.charCodeAt(d), !(!N(n) && n !== 10)); d++)
      ;
    if (d >= p) return !1;
    if (l = d, r = e.md.helpers.parseLinkDestination(e.src, d, e.posMax), r.ok) {
      for (s = e.md.normalizeLink(r.str), e.md.validateLink(s) ? d = r.pos : s = "", l = d; d < p && (n = e.src.charCodeAt(d), !(!N(n) && n !== 10)); d++)
        ;
      if (r = e.md.helpers.parseLinkTitle(e.src, d, e.posMax), d < p && l !== d && r.ok)
        for (a = r.str, d = r.pos; d < p && (n = e.src.charCodeAt(d), !(!N(n) && n !== 10)); d++)
          ;
    }
    (d >= p || e.src.charCodeAt(d) !== 41) && (u = !0), d++;
  }
  if (u) {
    if (typeof e.env.references > "u") return !1;
    if (d < p && e.src.charCodeAt(d) === 91 ? (l = d + 1, d = e.md.helpers.parseLinkLabel(e, d), d >= 0 ? o = e.src.slice(l, d++) : d = c + 1) : d = c + 1, o || (o = e.src.slice(g, c)), o = Ft(o), i = e.env.references[o], !i)
      return e.pos = h, !1;
    s = i.href, a = i.title;
  }
  if (!t) {
    e.pos = g, e.posMax = c;
    let m = e.push("link_open", "a", 1), f = [["href", s]];
    if (m.attrs = f, a && f.push(["title", a]), o) {
      let y = /* @__PURE__ */ Object.create(null);
      y.label = o, m.meta = y;
    }
    e.linkLevel++, e.md.inline.tokenize(e), e.linkLevel--, e.push("link_close", "a", -1);
  }
  return e.pos = d, e.posMax = p, !0;
}
function Bd(e, t) {
  let n, o, r, i, s, a, l, u, h = "", p = e.pos, g = e.posMax;
  if (e.src.charCodeAt(e.pos) !== 33 || e.src.charCodeAt(e.pos + 1) !== 91) return !1;
  let c = e.pos + 2, d = e.md.helpers.parseLinkLabel(e, e.pos + 1, !1);
  if (d < 0) return !1;
  if (i = d + 1, i < g && e.src.charCodeAt(i) === 40) {
    for (i++; i < g && (n = e.src.charCodeAt(i), !(!N(n) && n !== 10)); i++)
      ;
    if (i >= g) return !1;
    for (u = i, a = e.md.helpers.parseLinkDestination(e.src, i, e.posMax), a.ok && (h = e.md.normalizeLink(a.str), e.md.validateLink(h) ? i = a.pos : h = ""), u = i; i < g && (n = e.src.charCodeAt(i), !(!N(n) && n !== 10)); i++)
      ;
    if (a = e.md.helpers.parseLinkTitle(e.src, i, e.posMax), i < g && u !== i && a.ok)
      for (l = a.str, i = a.pos; i < g && (n = e.src.charCodeAt(i), !(!N(n) && n !== 10)); i++)
        ;
    else l = "";
    if (i >= g || e.src.charCodeAt(i) !== 41)
      return e.pos = p, !1;
    i++;
  } else {
    if (typeof e.env.references > "u") return !1;
    if (i < g && e.src.charCodeAt(i) === 91 ? (u = i + 1, i = e.md.helpers.parseLinkLabel(e, i), i >= 0 ? r = e.src.slice(u, i++) : i = d + 1) : i = d + 1, r || (r = e.src.slice(c, d)), r = Ft(r), s = e.env.references[r], !s)
      return e.pos = p, !1;
    h = s.href, l = s.title;
  }
  if (!t) {
    o = e.src.slice(c, d);
    let m = [];
    e.md.inline.parse(o, e.md, e.env, m);
    let f = e.push("image", "img", 0), y = [["src", h], ["alt", ""]];
    if (f.attrs = y, f.children = m, f.content = o, l && y.push(["title", l]), r) {
      let w = /* @__PURE__ */ Object.create(null);
      w.label = r, f.meta = w;
    }
  }
  return e.pos = i, e.posMax = g, !0;
}
var Gd = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/, Hd = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function zd(e, t) {
  let n = e.pos;
  if (e.src.charCodeAt(n) !== 60) return !1;
  let o = e.pos, r = e.posMax;
  for (; ; ) {
    if (++n >= r) return !1;
    let s = e.src.charCodeAt(n);
    if (s === 60) return !1;
    if (s === 62) break;
  }
  let i = e.src.slice(o + 1, n);
  if (Hd.test(i)) {
    let s = e.md.normalizeLink(i);
    if (!e.md.validateLink(s)) return !1;
    if (!t) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let l = e.push("text", "", 0);
      l.content = e.md.normalizeLinkText(i);
      let u = e.push("link_close", "a", -1);
      u.markup = "autolink", u.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  if (Gd.test(i)) {
    let s = e.md.normalizeLink(`mailto:${i}`);
    if (!e.md.validateLink(s)) return !1;
    if (!t) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let l = e.push("text", "", 0);
      l.content = e.md.normalizeLinkText(i);
      let u = e.push("link_close", "a", -1);
      u.markup = "autolink", u.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  return !1;
}
function qd(e) {
  return /^<a[>\s]/i.test(e);
}
function Wd(e) {
  return /^<\/a\s*>/i.test(e);
}
function jd(e) {
  let t = e | 32;
  return t >= 97 && t <= 122;
}
function $d(e, t) {
  if (!e.md.options.html) return !1;
  let n = e.posMax, o = e.pos;
  if (e.src.charCodeAt(o) !== 60 || o + 2 >= n) return !1;
  let r = e.src.charCodeAt(o + 1);
  if (r !== 33 && r !== 63 && r !== 47 && !jd(r)) return !1;
  let i = e.src.slice(o).match(bd);
  if (!i) return !1;
  if (!t) {
    let s = e.push("html_inline", "", 0);
    s.content = i[0], qd(s.content) && e.linkLevel++, Wd(s.content) && e.linkLevel--;
  }
  return e.pos += i[0].length, !0;
}
var Kd = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i, Vd = /^&([a-z][a-z0-9]{1,31});/i;
function Yd(e, t) {
  let n = e.pos, o = e.posMax;
  if (e.src.charCodeAt(n) !== 38 || n + 1 >= o) return !1;
  if (e.src.charCodeAt(n + 1) === 35) {
    let r = e.src.slice(n).match(Kd);
    if (r) {
      if (!t) {
        let i = r[1][0].toLowerCase() === "x" ? parseInt(r[1].slice(1), 16) : parseInt(r[1], 10), s = e.push("text_special", "", 0);
        s.content = Fn(i) ? Je(i) : Je(65533), s.markup = r[0], s.info = "entity";
      }
      return e.pos += r[0].length, !0;
    }
  } else {
    let r = e.src.slice(n).match(Vd);
    if (r) {
      let i = Ot(r[0]);
      if (i !== r[0]) {
        if (!t) {
          let s = e.push("text_special", "", 0);
          s.content = i, s.markup = r[0], s.info = "entity";
        }
        return e.pos += r[0].length, !0;
      }
    }
  }
  return !1;
}
function zi(e) {
  let t = {}, n = e.length;
  if (!n) return;
  let o = 0, r = -2, i = [];
  for (let s = 0; s < n; s++) {
    let a = e[s];
    if (i.push(0), (e[o].marker !== a.marker || r !== a.token - 1) && (o = s), r = a.token, a.length = a.length || 0, !a.close) continue;
    t.hasOwnProperty(a.marker) || (t[a.marker] = [
      -1,
      -1,
      -1,
      -1,
      -1,
      -1
    ]);
    let l = t[a.marker][(a.open ? 3 : 0) + a.length % 3], u = o - i[o] - 1, h = u;
    for (; u > l; u -= i[u] + 1) {
      let p = e[u];
      if (p.marker === a.marker && p.open && p.end < 0) {
        let g = !1;
        if ((p.close || a.open) && (p.length + a.length) % 3 === 0 && (p.length % 3 !== 0 || a.length % 3 !== 0) && (g = !0), !g) {
          let c = u > 0 && !e[u - 1].open ? i[u - 1] + 1 : 0;
          i[s] = s - u + c, i[u] = c, a.open = !1, p.end = s, p.close = !1, h = -1, r = -2;
          break;
        }
      }
    }
    h !== -1 && (t[a.marker][(a.open ? 3 : 0) + (a.length || 0) % 3] = h);
  }
}
function Zd(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  zi(e.delimiters);
  for (let r = 0; r < n; r++) {
    var o;
    let i = (o = t[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && zi(i);
  }
}
function Jd(e) {
  let t, n, o = 0, r = e.tokens, i = e.tokens.length;
  for (t = n = 0; t < i; t++)
    r[t].nesting < 0 && o--, r[t].level = o, r[t].nesting > 0 && o++, r[t].type === "text" && t + 1 < i && r[t + 1].type === "text" ? r[t + 1].content = r[t].content + r[t + 1].content : (t !== n && (r[n] = r[t]), n++);
  t !== n && (r.length = n);
}
var On = [
  ["text", Td],
  ["linkify", _d],
  ["newline", Id],
  ["escape", Pd],
  ["backticks", Md],
  ["strikethrough", rs.tokenize],
  ["emphasis", os.tokenize],
  ["link", Ld],
  ["image", Bd],
  ["autolink", zd],
  ["html_inline", $d],
  ["entity", Yd]
], Nn = [
  ["balance_pairs", Zd],
  ["strikethrough", rs.postProcess],
  ["emphasis", os.postProcess],
  ["fragments_join", Jd]
], is = class {
  constructor() {
    v(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of inline rules.
      */
      "ruler",
      new nt()
    ), v(
      this,
      /**
      * {@link Ruler} instance. Second ruler used for post-processing
      * (e.g. in emphasis-like rules).
      */
      "ruler2",
      new nt()
    ), v(this, "State", ns);
    for (let e = 0; e < On.length; e++) this.ruler.push(On[e][0], On[e][1]);
    for (let e = 0; e < Nn.length; e++) this.ruler2.push(Nn[e][0], Nn[e][1]);
  }
  skipToken(e) {
    let t = e.pos, n = this.ruler.getRules(""), o = n.length, r = e.md.options.maxNesting, i = e.cache;
    if (typeof i[t] < "u") {
      e.pos = i[t];
      return;
    }
    let s = !1;
    if (e.level < r) {
      for (let a = 0; a < o; a++)
        if (e.level++, s = n[a](e, !0), e.level--, s) {
          if (t >= e.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
    } else e.pos = e.posMax;
    s || e.pos++, i[t] = e.pos;
  }
  tokenize(e) {
    let t = this.ruler.getRules(""), n = t.length, o = e.posMax, r = e.md.options.maxNesting;
    for (; e.pos < o; ) {
      let i = e.pos, s = !1;
      if (e.level < r) {
        for (let a = 0; a < n; a++)
          if (s = t[a](e, !1), s) {
            if (i >= e.pos) throw new Error("inline rule didn't increment state.pos");
            break;
          }
      }
      if (s) {
        if (e.pos >= o) break;
        continue;
      }
      e.pending += e.src[e.pos++];
    }
    e.pending && e.pushPending();
  }
  /**
  * Process input string and push inline tokens into `outTokens`
  */
  parse(e, t, n, o) {
    let r = new this.State(e, t, n, o);
    this.tokenize(r);
    let i = this.ruler2.getRules(""), s = i.length;
    for (let a = 0; a < s; a++) i[a](r);
  }
}, Xd = {
  default: {
    options: {
      html: !1,
      xhtmlOut: !1,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 100
    },
    components: {
      core: {},
      block: {},
      inline: {}
    }
  },
  zero: {
    options: {
      html: !1,
      xhtmlOut: !1,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 20
    },
    components: {
      core: { rules: [
        "normalize",
        "block",
        "strip_references",
        "inline",
        "text_join"
      ] },
      block: { rules: ["paragraph"] },
      inline: {
        rules: ["text"],
        rules2: ["balance_pairs", "fragments_join"]
      }
    }
  },
  commonmark: {
    options: {
      html: !0,
      xhtmlOut: !0,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 20
    },
    components: {
      core: { rules: [
        "normalize",
        "block",
        "strip_references",
        "inline",
        "text_join"
      ] },
      block: { rules: [
        "blockquote",
        "code",
        "fence",
        "heading",
        "hr",
        "html_block",
        "lheading",
        "list",
        "reference",
        "paragraph"
      ] },
      inline: {
        rules: [
          "autolink",
          "backticks",
          "emphasis",
          "entity",
          "escape",
          "html_inline",
          "image",
          "link",
          "newline",
          "text"
        ],
        rules2: [
          "balance_pairs",
          "emphasis",
          "fragments_join"
        ]
      }
    }
  }
}, Qd = /^(vbscript|javascript|file|data):/, eu = /^data:image\/(gif|png|jpeg|webp);/, qi = [
  "http:",
  "https:",
  "mailto:"
], ne = class {
  /**
  * Link validation function. CommonMark allows too much in links. By default
  * we disable `javascript:`, `vbscript:`, `file:` schemas, and almost all `data:...` schemas
  * except some embedded image types.
  *
  * You can change this behaviour:
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * // enable everything
  * md.validateLink = function () { return true; }
  * ```
  */
  validateLink(e) {
    let t = e.trim().toLowerCase();
    return Qd.test(t) ? eu.test(t) : !0;
  }
  /**
  * Function used to encode link url to a machine-readable format,
  * which includes url-encoding, punycode, etc.
  */
  normalizeLink(e) {
    let t = Ye(e, !0);
    if (t.hostname && (!t.protocol || qi.indexOf(t.protocol) >= 0))
      try {
        t.hostname = Un.default.toASCII(t.hostname);
      } catch {
      }
    return t.auth && (t.auth = ue(t.auth)), t.hostname && (t.hostname = ue(t.hostname)), t.pathname && (t.pathname = ue(t.pathname)), t.search && (t.search = ue(t.search)), t.hash && (t.hash = ue(t.hash)), Fe(t);
  }
  /**
  * Function used to decode link url to a human-readable format`
  */
  normalizeLinkText(e) {
    let t = Ye(e, !0);
    if (t.hostname && (!t.protocol || qi.indexOf(t.protocol) >= 0))
      try {
        t.hostname = Un.default.toUnicode(t.hostname);
      } catch {
      }
    return Ve(Fe(t), Ve.defaultChars + "%");
  }
  constructor(...e) {
    v(
      this,
      /**
      * Instance of {@link ParserInline}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "inline",
      new is()
    ), v(
      this,
      /**
      * Instance of {@link ParserBlock}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "block",
      new ts()
    ), v(
      this,
      /**
      * Instance of {@link ParserCore} chain executor. You may need it to add new
      * rules when writing plugins. For simple rules control use
      * {@link MarkdownIt.disable} and {@link MarkdownIt.enable}.
      */
      "core",
      new Ji()
    ), v(
      this,
      /**
      * Instance of {@link Renderer}. Use it to modify output look. Or to add rendering
      * rules for new token types, generated by plugins.
      *
      * See {@link Renderer} docs and
      * [source code](https://github.com/markdown-it/markdown-it/blob/master/src/renderer.ts).
      *
      * @example
      * ```javascript
      * import MarkdownIt from 'markdown-it'
      * const md = new MarkdownIt()
      *
      * function myToken(tokens, idx, options, env, self) {
      *   //...
      *   return result;
      * };
      *
      * md.renderer.rules['my_token'] = myToken
      * ```
      */
      "renderer",
      new Vi()
    ), v(
      this,
      /**
      * [linkify-it](https://github.com/markdown-it/linkify-it) instance.
      * Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/src/rules_core/linkify.ts)
      * rule.
      */
      "linkify",
      new xi()
    ), v(
      this,
      /**
      * Assorted utility functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/common/utils.ts).
      */
      "utils",
      kl
    ), v(
      this,
      /**
      * Link components parser functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/helpers).
      */
      "helpers",
      Object.assign({}, Fl)
    );
    let [t, n] = e;
    typeof t == "string" ? (this.configure(t), n && this.set(n)) : (this.configure("default"), this.set(t || {}));
  }
  /**
  * Set parser options (in the same format as in constructor). Probably, you
  * will never need it, but you can change options after constructor call.
  *
  * __Note:__ To achieve the best possible performance, don't modify a
  * `markdown-it` instance options on the fly. If you need multiple configurations
  * it's best to create multiple instances and initialize each with separate
  * config.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  *
  * const md = new MarkdownIt()
  *   .set({ html: true, breaks: true })
  *   .set({ typographer: true })
  * ```
  */
  set(e) {
    return Object.assign(this.options, e), this;
  }
  /**
  * Batch load of all options and compenent settings. This is internal method,
  * and you probably will not need it. But if you will - see available presets
  * and data structure [here](https://github.com/markdown-it/markdown-it/tree/master/src/presets)
  *
  * We strongly recommend to use presets instead of direct config loads. That
  * will give better compatibility with next versions.
  */
  configure(e) {
    let t;
    if (typeof e == "string") {
      let r = e;
      if (t = Xd[r], !t) throw new Error(`Wrong 'markdown-it' preset "${r}", check name`);
    } else t = e;
    if (!t) throw new Error("Wrong `markdown-it` preset, can't be empty");
    t.options && (this.options = { ...t.options });
    let n = t.components;
    if (n) {
      var o;
      [
        "core",
        "block",
        "inline"
      ].forEach((i) => {
        var s;
        let a = (s = n[i]) === null || s === void 0 ? void 0 : s.rules;
        a && this[i].ruler.enableOnly(a);
      });
      let r = (o = n.inline) === null || o === void 0 ? void 0 : o.rules2;
      r && this.inline.ruler2.enableOnly(r);
    }
    return this;
  }
  /**
  * Enable list or rules. It will automatically find appropriate components,
  * containing rules with given names. If rule not found, and `ignoreInvalid`
  * not set - throws exception.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  *
  * const md = new MarkdownIt()
  *   .enable(['sub', 'sup'])
  *   .disable('smartquotes')
  * ```
  */
  enable(e, t = !1) {
    let n = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((r) => {
      n = n.concat(this[r].ruler.enable(e, !0));
    }), n = n.concat(this.inline.ruler2.enable(e, !0));
    let o = e.filter((r) => n.indexOf(r) < 0);
    if (o.length && !t) throw new Error(`MarkdownIt. Failed to enable unknown rule(s): ${o}`);
    return this;
  }
  /**
  * The same as {@link MarkdownIt.enable}, but turn specified rules off.
  */
  disable(e, t = !1) {
    let n = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((r) => {
      n = n.concat(this[r].ruler.disable(e, !0));
    }), n = n.concat(this.inline.ruler2.disable(e, !0));
    let o = e.filter((r) => n.indexOf(r) < 0);
    if (o.length && !t) throw new Error(`MarkdownIt. Failed to disable unknown rule(s): ${o}`);
    return this;
  }
  /**
  * Load specified plugin with given params into current parser instance.
  * It's just a sugar to call `plugin(md, params)` with curring.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * import iterator from 'markdown-it-for-inline'
  *
  * const md = new MarkdownIt()
  *   .use(iterator, 'foo_replace', 'text', function (tokens, idx) {
  *     tokens[idx].content = tokens[idx].content.replace(/foo/g, 'bar')
  *   })
  * ```
  */
  use(e, ...t) {
    return e.apply(e, [this, ...t]), this;
  }
  /**
  * Parse input string and return list of block tokens (special token type
  * "inline" will contain list of inline tokens). You should not call this
  * method directly, until you write custom renderer (for example, to produce
  * AST).
  *
  * `env` is used to pass data between "distributed" rules and return additional
  * metadata like reference info, needed for the renderer. It also can be used to
  * inject data in specific cases. Usually, you will be ok to pass `{}`,
  * and then pass updated object to renderer.
  */
  parse(e, t) {
    if (typeof e != "string") throw new Error("Input data should be a String");
    let n = new this.core.State(e, this, t);
    return this.core.process(n), n.tokens;
  }
  /**
  * Render markdown string into html. It does all magic for you :).
  *
  * `env` can be used to inject additional metadata (`{}` by default).
  * But you will not need it with high probability. See also comment
  * in {@link MarkdownIt.parse}.
  */
  render(e, t = {}) {
    return this.renderer.render(this.parse(e, t), this.options, t);
  }
  /**
  * The same as {@link MarkdownIt.parse} but skip all block rules. It returns
  * the block tokens list with the single `inline` element, containing parsed
  * inline tokens in `children` property. Also updates `env` object.
  */
  parseInline(e, t) {
    let n = new this.core.State(e, this, t);
    return n.inlineMode = !0, this.core.process(n), n.tokens;
  }
  /**
  * Similar to {@link MarkdownIt.render} but for single paragraph content.
  * Result will NOT be wrapped into `<p>` tags.
  */
  renderInline(e, t = {}) {
    return this.renderer.render(this.parseInline(e, t), this.options, t);
  }
};
v(ne, "Token", Ae);
v(ne, "Ruler", nt);
v(ne, "Renderer", Vi);
v(ne, "ParserCore", Ji);
v(ne, "StateCore", Yi);
v(ne, "ParserBlock", ts);
v(ne, "StateBlock", Xi);
v(ne, "ParserInline", is);
v(ne, "StateInline", ns);
var tu = ji(ne);

// openclaw/packages/net-policy/src/ip.ts
F();
var cs = zn(as(), 1);
var Pb = [cs.default.IPv4.parse("198.18.0.0"), 15];

// openclaw/src/media/parse-output.ts
Y();

// openclaw/src/utils/directive-tags.ts
Y();
en();
F();

// openclaw/src/shared/text/text-projection.ts
Y();

// openclaw/packages/markdown-core/src/fences.ts
var nu = /(?:^|\n)( {0,3})(`{3,}|~{3,})([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g, Mb = new RegExp(nu, "gy");

// openclaw/packages/tool-call-repair/src/grammar.ts
var jb = new TextEncoder();

// openclaw/src/shared/clawhub-recommendations.ts
D();
var ls = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind"
], NS = /* @__PURE__ */ new Set([...ls, "pluginId"]), US = /* @__PURE__ */ new Set([...ls, "registry", "skillRef"]);

// openclaw/ui/src/lib/chat/imported-message-display.ts
D();

// openclaw/ui/src/lib/chat/message-normalizer-attachments.ts
oe();
D();

// openclaw/ui/src/lib/chat/message-normalizer-images.ts
oe();
D();
F();

// openclaw/ui/src/lib/chat/sender-label.ts
F();

// openclaw/ui/src/lib/chat/message-normalizer.ts
function Bn(e) {
  return Ct(G(e)?.role);
}

// openclaw/ui/src/lib/chat/tool-call-diff.ts
D();
function ds(e) {
  let t = he(e), n = t?.added, o = t?.removed;
  return typeof n == "number" && Number.isInteger(n) && n >= 0 && typeof o == "number" && Number.isInteger(o) && o >= 0 ? { added: n, removed: o } : void 0;
}

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
D();

// openclaw/src/agents/agent-activity-presentation.ts
D();
F();

// openclaw/src/session-cards/progress-card-input.ts
D();

// openclaw/src/agents/agent-activity-presentation.ts
function _e(e, t) {
  return t.map((n) => [n, e]);
}
var jk = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ..._e("subagents", ["sessions_spawn"]),
  ..._e("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ..._e("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ..._e("edits", [
    "edit",
    "apply_patch",
    "applypatch",
    "patch",
    "edit_file",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit"
  ]),
  ..._e("writes", ["write", "write_file", "create_file"]),
  ..._e("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search"
  ]),
  ..._e("fetches", ["web_fetch", "webfetch", "fetch"])
]);

// openclaw/ui/src/lib/protocol-validators.generated/activity.js
function su(e) {
  let t = 0, n = 0, o = 0;
  for (; n < e.length; ) {
    let r = e.charCodeAt(n++) >> 10;
    t += +((o << 8 | r) !== 13879), o = r;
  }
  return t;
}
function au(e) {
  return su(e);
}
var us = /* @__PURE__ */ (() => {
  let e = [
    new RegExp(
      "(^itemId$|^phase$|^kind$|^title$|^status$|^name$|^meta$|^commandBearing$|^toolCallId$|^unpairedCall$|^startedAt$|^endedAt$|^error$|^summary$|^progressText$|^suppressChannelProgress$|^hideFromChannelProgress$|^approvalId$|^approvalSlug$)",
      "u"
    )
  ], t = (n) => typeof n == "object" && n !== null && !Array.isArray(n) && "itemId" in n && "phase" in n && "kind" in n && "title" in n && Object.getOwnPropertyNames(n).every((o, r) => e[0].test(o) || !1) && typeof n.itemId == "string" && (n.itemId.length >= 2 || n.itemId.length >= 1 && au(n.itemId) >= 1) && (typeof n.phase == "string" && n.phase === "start" || typeof n.phase == "string" && n.phase === "update" || typeof n.phase == "string" && n.phase === "end") && typeof n.kind == "string" && typeof n.title == "string" && (n.status === void 0 || !("status" in n) || typeof n.status == "string" && n.status === "running" || typeof n.status == "string" && n.status === "completed" || typeof n.status == "string" && n.status === "failed" || typeof n.status == "string" && n.status === "blocked" || typeof n.status == "string" && n.status === "skipped") && (n.name === void 0 || !("name" in n) || typeof n.name == "string") && (n.meta === void 0 || !("meta" in n) || typeof n.meta == "string") && (n.commandBearing === void 0 || !("commandBearing" in n) || typeof n.commandBearing == "boolean") && (n.toolCallId === void 0 || !("toolCallId" in n) || typeof n.toolCallId == "string") && (n.unpairedCall === void 0 || !("unpairedCall" in n) || typeof n.unpairedCall == "boolean") && (n.startedAt === void 0 || !("startedAt" in n) || Number.isFinite(n.startedAt)) && (n.endedAt === void 0 || !("endedAt" in n) || Number.isFinite(n.endedAt)) && (n.error === void 0 || !("error" in n) || typeof n.error == "string") && (n.summary === void 0 || !("summary" in n) || typeof n.summary == "string") && (n.progressText === void 0 || !("progressText" in n) || typeof n.progressText == "string") && (n.suppressChannelProgress === void 0 || !("suppressChannelProgress" in n) || typeof n.suppressChannelProgress == "boolean") && (n.hideFromChannelProgress === void 0 || !("hideFromChannelProgress" in n) || typeof n.hideFromChannelProgress == "boolean") && (n.approvalId === void 0 || !("approvalId" in n) || typeof n.approvalId == "string") && (n.approvalSlug === void 0 || !("approvalSlug" in n) || typeof n.approvalSlug == "string");
  return (n) => t(n);
})();

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
function ps(e) {
  let t = G(e)?.activity;
  return Array.isArray(t) ? t.filter(us) : [];
}

// openclaw/ui/src/lib/chat/tool-cards.ts
function cu(e) {
  return O(e.messageId) ?? O(L(e.__openclaw)?.id);
}
function fs(e) {
  let t = L(L(e)?.__openclaw), n = L(t?.toolOutput);
  return (n?.source === "provider-response" || n?.source === "execution") && n.modelInput === "unverified" ? {
    source: n.source,
    modelInput: n.modelInput,
    ...n.outcome === "unknown" ? { outcome: "unknown" } : {},
    ...n.captureTruncated === !0 ? { captureTruncated: !0 } : {}
  } : void 0;
}
function lu(e) {
  return Array.isArray(e) ? e.filter((t) => he(t) !== null) : [];
}
function du(e) {
  if (typeof e != "string")
    return e;
  let t = e.trim();
  return t.startsWith("{") || t.startsWith("[") ? nn(t) ?? e : e;
}
function uu(e) {
  if (typeof e.text == "string")
    return e.text;
  if (typeof e.content == "string")
    return e.content;
  if (Array.isArray(e.content)) {
    let t = e.content.flatMap((n) => {
      let o = he(n)?.text;
      return typeof o == "string" ? [o] : [];
    });
    if (t.length > 0)
      return t.join(`
`);
  }
}
function pu(...e) {
  for (let t of e) {
    let n = he(t), o = n?.exitCode ?? n?.exit_code;
    if (typeof o == "number" && Number.isInteger(o))
      return o;
  }
}
function ws(e) {
  if (e.activity)
    return e.activity.status === "skipped";
  let t = he(e.details);
  return (e.live !== !0 || e.completed === !0) && t?.status === "skipped" && t.deniedReason === "steering";
}
function hs(e) {
  if (ws(e))
    return !1;
  if (e.activity)
    return e.activity.status === "failed";
  let t = e.live !== !0 || e.completed === !0;
  return e.isError ?? (t && Jo(e.outputText));
}
function bs(e, t) {
  if (ws(e))
    return "skipped";
  if (e.toolOutput?.outcome === "unknown")
    return hs(e) ? "failed" : "unknown";
  if (e.activity) {
    let { status: n, phase: o } = e.activity;
    return n === "failed" || n === "blocked" ? n : n === "completed" ? "succeeded" : t === !0 && e.live === !0 && (n === "running" || o !== "end" && e.completed !== !0) ? "running" : "unknown";
  }
  return hs(e) ? "failed" : t === !0 && e.live === !0 && e.completed !== !0 ? "running" : e.completed === !0 || e.live !== !0 && e.outputText !== void 0 ? "succeeded" : "unknown";
}
function fu(e) {
  let t = Vo(e);
  return t?.surface === "assistant_message" ? { ...t, surface: "assistant_message" } : void 0;
}
function hu(e, t, n) {
  let o = Ko(e), r = o?.surface === "assistant_message" ? { ...o, surface: "assistant_message" } : fu(t);
  if (r)
    return { preview: { ...r, surface: "assistant_message" } };
  let i = L(L(e)?.browserTab), s = bn(i);
  if (n !== "browser" || !i || !s)
    return {};
  let a = typeof i.url == "string" ? ze(i.url, 2048) : "";
  return {
    browserTab: s,
    preview: Ho(a) ? {
      kind: "browser-tab",
      ...s,
      url: a,
      ...typeof i.title == "string" ? { title: ze(i.title, 512) } : {}
    } : void 0
  };
}
function gs(e, t) {
  return Zo(e) ?? W(e.callId) ?? W(t.toolCallId) ?? W(t.tool_call_id) ?? W(t.toolUseId) ?? W(t.tool_use_id);
}
function Gn(e, t) {
  return W(e.name) ?? W(t.toolName) ?? W(t.tool_name) ?? "tool";
}
function gu(e) {
  if (e != null)
    return typeof e == "string" ? e : JSON.stringify(e, null, 2);
}
var mu = 0;
function yu(e) {
  return Sn(e.type) || typeof e.name == "string" && (e.arguments != null || e.args != null || e.input != null);
}
function ms(e) {
  let t = e, n = typeof t.role == "string" ? t.role.toLowerCase() : "", o = Bn(e) || n === "tool" || n === "function" || typeof t.toolName == "string" || typeof t.tool_name == "string", r = lu(t.content), i = Tt(t), s = t.__openclawToolStreamLive === !0, a = ds(t.__openclawToolStreamDiffStat), l = [], u = /* @__PURE__ */ new WeakSet(), h = cu(t), p = Zt(t)?.runId ?? O(t.runId), g = (m, f, y = !1) => {
    let w = uu(m), b = m.details ?? t.details, S = L(m.__openclaw), k = Tt(m) ?? i, R = pu(
      m,
      b,
      w ? be(w.trim()) : void 0,
      y ? void 0 : t
    );
    return {
      outputText: w,
      resultMessageId: !y && S && Object.hasOwn(S, "id") ? O(S.id) : h,
      outputTruncated: (S && Object.hasOwn(S, "truncated") ? S : L(t.__openclaw))?.truncated === !0,
      toolOutput: fs(m) ?? fs(t),
      ...b !== void 0 ? { details: b } : {},
      ...k !== void 0 ? { isError: k } : {},
      ...R !== void 0 ? { exitCode: R } : {},
      ...hu(b, w, f)
    };
  };
  for (let m = 0; m < r.length; m++) {
    let f = r[m] ?? {}, y = yu(f);
    if (!y && !Ct(f.type))
      continue;
    let w = O(f.runId) ?? p, b = O(f.parentToolCallId), S = gs(f, t), k = Gn(f, t), R = {
      id: S ?? `${k}:${m}`,
      ...S ? { callId: S } : {},
      ...w ? { runId: w } : {},
      ...b ? { parentToolCallId: b } : {},
      name: k,
      messageId: h
    }, I = f.details ?? t.details;
    if (y) {
      let A = du(f.arguments ?? f.args ?? f.input);
      l.push({
        ...R,
        args: A,
        inputText: gu(A),
        ...I !== void 0 ? { details: I } : {},
        ...s ? {
          live: !0,
          completed: t.__openclawToolStreamResultReceived === !0 || t.__openclawToolStreamItemEnded === !0
        } : {},
        ...a ? { liveDiffStat: a } : {}
      });
      continue;
    }
    let E = l.find((A) => A.id === R.id) ?? l.find(
      (A) => (
        // Same-name fallback belongs to legacy blocks missing an explicit identity.
        (!S || !A.callId) && A.name === k && A.outputText === void 0 && !u.has(A)
      )
    ), T = o ? Gn({}, t) : void 0, M = T && T !== "browser" ? T : E?.name ?? T ?? k, _ = g(f, M);
    if (E) {
      u.add(E), E.callId ??= S, E.runId ??= w, E.parentToolCallId ??= b, s || (E.completed = !0), Object.assign(E, _, {
        preview: _.preview,
        browserTab: _.browserTab
      });
      continue;
    }
    l.push({
      ...R,
      completed: !0,
      ..._
    });
  }
  if (o && l.length === 0) {
    let m = typeof t.toolName == "string" && t.toolName || typeof t.tool_name == "string" && t.tool_name || "tool", f = gs({}, t);
    l.push({
      id: f ?? `${Gn({}, t)}:0`,
      ...f ? { callId: f } : {},
      ...p ? { runId: p } : {},
      name: m,
      completed: Bn(e) || n === "tool" || n === "function",
      messageId: h,
      ...g(t, m, !0)
    });
  }
  let c = new Map(
    ps(e).filter((m) => !m.suppressChannelProgress).map((m) => [m.toolCallId ?? m.itemId, m])
  ), d;
  for (let [m, f] of l.entries()) {
    let y = f.callId ? c.get(f.callId) : void 0;
    y && (f.activity = y), !(!f.browserTab || f.callId || f.messageId) && (d ??= ++mu, f.previewRevision = `${d}:${m}`);
  }
  return l;
}
var ys = /* @__PURE__ */ new WeakMap();
function Ss(e) {
  if (!e || typeof e != "object")
    return ms(e);
  let t = ys.get(e);
  if (t)
    return t;
  let n = ms(e);
  return ys.set(e, n), n;
}

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
function wu(e) {
  return e.callId ?? e.messageId ?? e.previewRevision;
}
var ks = /* @__PURE__ */ new WeakMap();
function Rs(e, t) {
  let n = ks.get(e);
  if (n?.toolMessages === t)
    return n.latest;
  let o = /* @__PURE__ */ new Map();
  for (let r of [e, t])
    for (let i of r)
      if (V(i))
        for (let s of Ss(i)) {
          let a = wu(s);
          if (s.browserTab && a && bs(s, !1) === "succeeded") {
            let l = Go(s.browserTab);
            o.delete(l), o.set(l, { tab: s.browserTab, revision: a });
          }
        }
  return ks.set(e, { toolMessages: t, latest: o }), o;
}

// octogee/app/openclaw-browser/resources.ts
function vR(e, t) {
  return [...Rs(e, []).values()].filter((o) => o.tab.target === "host" && o.tab.profile === t).at(-1) ?? null;
}
export {
  vR as latestNativeBrowserTab
};
/*!
TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

markdown-it/dist/markdown-it.mjs:
  (*! markdown-it 15.0.2 https://github.com/markdown-it/markdown-it @license MIT *)
*/
