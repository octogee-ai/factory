// @ts-nocheck
var kr = Object.create;
var Fe = Object.defineProperty;
var Cr = Object.getOwnPropertyDescriptor;
var Rr = Object.getOwnPropertyNames;
var _r = Object.getPrototypeOf, Tr = Object.prototype.hasOwnProperty;
var fn = (e, n) => () => {
  try {
    return n || e((n = { exports: {} }).exports, n), n.exports;
  } catch (t) {
    throw n = 0, t;
  }
}, gn = (e, n) => {
  for (var t in n)
    Fe(e, t, { get: n[t], enumerable: !0 });
}, Ir = (e, n, t, o) => {
  if (n && typeof n == "object" || typeof n == "function")
    for (let r of Rr(n))
      !Tr.call(e, r) && r !== t && Fe(e, r, { get: () => n[r], enumerable: !(o = Cr(n, r)) || o.enumerable });
  return e;
};
var hn = (e, n, t) => (t = e != null ? kr(_r(e)) : {}, Ir(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  n || !e || !e.__esModule ? Fe(t, "default", { value: e, enumerable: !0 }) : t,
  e
));

// openclaw/node_modules/.pnpm/punycode.js@2.3.1/node_modules/punycode.js/punycode.js
var ht = fn((El, gt) => {
  "use strict";
  var To = /^xn--/, Io = /[^\0-\x7F]/, So = /[\x2E\u3002\uFF0E\uFF61]/g, Ao = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  }, en = 35, W = Math.floor, nn = String.fromCharCode;
  function K(e) {
    throw new RangeError(Ao[e]);
  }
  function Eo(e, n) {
    let t = [], o = e.length;
    for (; o--; )
      t[o] = n(e[o]);
    return t;
  }
  function ct(e, n) {
    let t = e.split("@"), o = "";
    t.length > 1 && (o = t[0] + "@", e = t[1]), e = e.replace(So, ".");
    let r = e.split("."), i = Eo(r, n).join(".");
    return o + i;
  }
  function lt(e) {
    let n = [], t = 0, o = e.length;
    for (; t < o; ) {
      let r = e.charCodeAt(t++);
      if (r >= 55296 && r <= 56319 && t < o) {
        let i = e.charCodeAt(t++);
        (i & 64512) == 56320 ? n.push(((r & 1023) << 10) + (i & 1023) + 65536) : (n.push(r), t--);
      } else
        n.push(r);
    }
    return n;
  }
  var vo = (e) => String.fromCodePoint(...e), Mo = function(e) {
    return e >= 48 && e < 58 ? 26 + (e - 48) : e >= 65 && e < 91 ? e - 65 : e >= 97 && e < 123 ? e - 97 : 36;
  }, ut = function(e, n) {
    return e + 22 + 75 * (e < 26) - ((n != 0) << 5);
  }, dt = function(e, n, t) {
    let o = 0;
    for (e = t ? W(e / 700) : e >> 1, e += W(e / n); e > en * 26 >> 1; o += 36)
      e = W(e / en);
    return W(o + (en + 1) * e / (e + 38));
  }, pt = function(e) {
    let n = [], t = e.length, o = 0, r = 128, i = 72, s = e.lastIndexOf("-");
    s < 0 && (s = 0);
    for (let a = 0; a < s; ++a)
      e.charCodeAt(a) >= 128 && K("not-basic"), n.push(e.charCodeAt(a));
    for (let a = s > 0 ? s + 1 : 0; a < t; ) {
      let l = o;
      for (let h = 1, f = 36; ; f += 36) {
        a >= t && K("invalid-input");
        let y = Mo(e.charCodeAt(a++));
        y >= 36 && K("invalid-input"), y > W((2147483647 - o) / h) && K("overflow"), o += y * h;
        let u = f <= i ? 1 : f >= i + 26 ? 26 : f - i;
        if (y < u)
          break;
        let c = 36 - u;
        h > W(2147483647 / c) && K("overflow"), h *= c;
      }
      let d = n.length + 1;
      i = dt(o - l, d, l == 0), W(o / d) > 2147483647 - r && K("overflow"), r += W(o / d), o %= d, n.splice(o++, 0, r);
    }
    return String.fromCodePoint(...n);
  }, ft = function(e) {
    let n = [];
    e = lt(e);
    let t = e.length, o = 128, r = 0, i = 72;
    for (let l of e)
      l < 128 && n.push(nn(l));
    let s = n.length, a = s;
    for (s && n.push("-"); a < t; ) {
      let l = 2147483647;
      for (let h of e)
        h >= o && h < l && (l = h);
      let d = a + 1;
      l - o > W((2147483647 - r) / d) && K("overflow"), r += (l - o) * d, o = l;
      for (let h of e)
        if (h < o && ++r > 2147483647 && K("overflow"), h === o) {
          let f = r;
          for (let y = 36; ; y += 36) {
            let u = y <= i ? 1 : y >= i + 26 ? 26 : y - i;
            if (f < u)
              break;
            let c = f - u, m = 36 - u;
            n.push(
              nn(ut(u + c % m, 0))
            ), f = W(c / m);
          }
          n.push(nn(ut(f, 0))), i = dt(r, d, a === s), r = 0, ++a;
        }
      ++r, ++o;
    }
    return n.join("");
  }, Do = function(e) {
    return ct(e, function(n) {
      return To.test(n) ? pt(n.slice(4).toLowerCase()) : n;
    });
  }, Po = function(e) {
    return ct(e, function(n) {
      return Io.test(n) ? "xn--" + ft(n) : n;
    });
  }, Oo = {
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
      decode: lt,
      encode: vo
    },
    decode: pt,
    encode: ft,
    toASCII: Po,
    toUnicode: Do
  };
  gt.exports = Oo;
});

// openclaw/node_modules/.pnpm/ipaddr.js@2.5.0/node_modules/ipaddr.js/lib/ipaddr.js
var Kt = fn((Jt, Pe) => {
  (function(e) {
    "use strict";
    let n = "(0?\\d+|0x[a-f0-9]+)", t = {
      fourOctet: new RegExp(`^${n}\\.${n}\\.${n}\\.${n}$`, "i"),
      threeOctet: new RegExp(`^${n}\\.${n}\\.${n}$`, "i"),
      twoOctet: new RegExp(`^${n}\\.${n}$`, "i"),
      longValue: new RegExp(`^${n}$`, "i")
    }, o = new RegExp("^0[0-7]+$", "i"), r = new RegExp("^0x[a-f0-9]+$", "i"), i = "%[0-9a-z]{1,}", s = "(?:[0-9a-f]+::?)+", a = {
      zoneIndex: new RegExp(i, "i"),
      native: new RegExp(`^(::)?(${s})?([0-9a-f]+)?(::)?(${i})?$`, "i"),
      deprecatedTransitional: new RegExp(`^(?:::)(${n}\\.${n}\\.${n}\\.${n}(${i})?)$`, "i"),
      transitional: new RegExp(`^((?:${s})|(?:::)(?:${s})?)${n}\\.${n}\\.${n}\\.${n}(${i})?$`, "i")
    };
    function l(u, c) {
      if (u.indexOf("::") !== u.lastIndexOf("::"))
        return null;
      let m = 0, p = -1, b = (u.match(a.zoneIndex) || [])[0], g, x;
      for (b && (b = b.substring(1), u = u.replace(/%.+$/, "")); (p = u.indexOf(":", p + 1)) >= 0; )
        m++;
      if (u.substr(0, 2) === "::" && m--, u.substr(-2, 2) === "::" && m--, m >= c)
        return null;
      for (x = c - m, g = ":"; x--; )
        g += "0:";
      return u = u.replace("::", g), u[0] === ":" && (u = u.slice(1)), u[u.length - 1] === ":" && (u = u.slice(0, -1)), c = (function() {
        let w = u.split(":"), k = [];
        for (let C = 0; C < w.length; C++)
          k.push(w[C].length > 4 ? NaN : parseInt(w[C], 16));
        return k;
      })(), {
        parts: c,
        zoneId: b
      };
    }
    function d(u, c, m, p) {
      if (u.length !== c.length)
        throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
      let b = 0, g;
      for (; p > 0; ) {
        if (g = m - p, g < 0 && (g = 0), u[b] >> g !== c[b] >> g)
          return !1;
        p -= m, b += 1;
      }
      return !0;
    }
    function h(u) {
      if (r.test(u))
        return parseInt(u, 16);
      if (u[0] === "0" && !isNaN(parseInt(u[1], 10))) {
        if (o.test(u))
          return parseInt(u, 8);
        throw new Error(`ipaddr: cannot parse ${u} as octal`);
      }
      return parseInt(u, 10);
    }
    function f(u, c) {
      for (; u.length < c; )
        u = `0${u}`;
      return u;
    }
    let y = {};
    y.IPv4 = (function() {
      function u(c) {
        if (c.length !== 4)
          throw new Error("ipaddr: ipv4 octet count should be 4");
        let m, p;
        for (m = 0; m < c.length; m++)
          if (p = c[m], !(0 <= p && p <= 255))
            throw new Error("ipaddr: ipv4 octet should fit in 8 bits");
        this.octets = c;
      }
      return u.prototype.SpecialRanges = {
        unspecified: [[new u([0, 0, 0, 0]), 8]],
        broadcast: [[new u([255, 255, 255, 255]), 32]],
        // RFC3171
        multicast: [[new u([224, 0, 0, 0]), 4]],
        // RFC3927
        linkLocal: [[new u([169, 254, 0, 0]), 16]],
        // RFC5735
        loopback: [[new u([127, 0, 0, 0]), 8]],
        // RFC6598
        carrierGradeNat: [[new u([100, 64, 0, 0]), 10]],
        // RFC1918
        private: [
          [new u([10, 0, 0, 0]), 8],
          [new u([172, 16, 0, 0]), 12],
          [new u([192, 168, 0, 0]), 16]
        ],
        // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
        reserved: [
          [new u([192, 0, 0, 0]), 24],
          [new u([192, 0, 2, 0]), 24],
          [new u([192, 88, 99, 0]), 24],
          [new u([198, 18, 0, 0]), 15],
          [new u([198, 51, 100, 0]), 24],
          [new u([203, 0, 113, 0]), 24],
          [new u([240, 0, 0, 0]), 4]
        ],
        // RFC7534, RFC7535
        as112: [
          [new u([192, 175, 48, 0]), 24],
          [new u([192, 31, 196, 0]), 24]
        ],
        // RFC7450
        amt: [
          [new u([192, 52, 193, 0]), 24]
        ]
      }, u.prototype.kind = function() {
        return "ipv4";
      }, u.prototype.match = function(c, m) {
        let p;
        if (m === void 0 && (p = c, c = p[0], m = p[1]), c.kind() !== "ipv4")
          throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
        return d(this.octets, c.octets, 8, m);
      }, u.prototype.prefixLengthFromSubnetMask = function() {
        let c = 0, m = !1, p = {
          0: 8,
          128: 7,
          192: 6,
          224: 5,
          240: 4,
          248: 3,
          252: 2,
          254: 1,
          255: 0
        }, b, g, x;
        for (b = 3; b >= 0; b -= 1)
          if (g = this.octets[b], g in p) {
            if (x = p[g], m && x !== 0)
              return null;
            x !== 8 && (m = !0), c += x;
          } else
            return null;
        return 32 - c;
      }, u.prototype.range = function() {
        return y.subnetMatch(this, this.SpecialRanges);
      }, u.prototype.toByteArray = function() {
        return this.octets.slice(0);
      }, u.prototype.toIPv4MappedAddress = function() {
        return y.IPv6.parse(`::ffff:${this.toString()}`);
      }, u.prototype.toNormalizedString = function() {
        return this.toString();
      }, u.prototype.toString = function() {
        return this.octets.join(".");
      }, u;
    })(), y.IPv4.broadcastAddressFromCIDR = function(u) {
      try {
        let c = this.parseCIDR(u), m = c[0].toByteArray(), p = this.subnetMaskFromPrefixLength(c[1]).toByteArray(), b = [], g = 0;
        for (; g < 4; )
          b.push(parseInt(m[g], 10) | parseInt(p[g], 10) ^ 255), g++;
        return new this(b);
      } catch (c) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: c });
      }
    }, y.IPv4.isIPv4 = function(u) {
      return this.parser(u) !== null;
    }, y.IPv4.isValid = function(u) {
      try {
        return new this(this.parser(u)), !0;
      } catch {
        return !1;
      }
    }, y.IPv4.isValidCIDR = function(u) {
      try {
        return this.parseCIDR(u), !0;
      } catch {
        return !1;
      }
    }, y.IPv4.isValidFourPartDecimal = function(u) {
      return !!(y.IPv4.isValid(u) && u.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/));
    }, y.IPv4.isValidCIDRFourPartDecimal = function(u) {
      let c = u.match(/^(.+)\/(\d+)$/);
      return !y.IPv4.isValidCIDR(u) || !c ? !1 : y.IPv4.isValidFourPartDecimal(c[1]);
    }, y.IPv4.networkAddressFromCIDR = function(u) {
      let c, m, p, b, g;
      try {
        for (c = this.parseCIDR(u), p = c[0].toByteArray(), g = this.subnetMaskFromPrefixLength(c[1]).toByteArray(), b = [], m = 0; m < 4; )
          b.push(parseInt(p[m], 10) & parseInt(g[m], 10)), m++;
        return new this(b);
      } catch (x) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: x });
      }
    }, y.IPv4.parse = function(u) {
      let c = this.parser(u);
      if (c === null)
        throw new Error("ipaddr: string is not formatted like an IPv4 Address");
      return new this(c);
    }, y.IPv4.parseCIDR = function(u) {
      let c;
      if (c = u.match(/^(.+)\/(\d+)$/)) {
        let m = parseInt(c[2]);
        if (m >= 0 && m <= 32) {
          let p = [this.parse(c[1]), m];
          return Object.defineProperty(p, "toString", {
            value: function() {
              return this.join("/");
            }
          }), p;
        }
      }
      throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
    }, y.IPv4.parser = function(u) {
      let c, m, p;
      if (c = u.match(t.fourOctet))
        return (function() {
          let b = c.slice(1, 6), g = [];
          for (let x = 0; x < b.length; x++)
            m = b[x], g.push(h(m));
          return g;
        })();
      if (c = u.match(t.longValue)) {
        if (p = h(c[1]), p > 4294967295 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return (function() {
          let b = [], g;
          for (g = 0; g <= 24; g += 8)
            b.push(p >> g & 255);
          return b;
        })().reverse();
      } else return (c = u.match(t.twoOctet)) ? (function() {
        let b = c.slice(1, 4), g = [];
        if (p = h(b[1]), p > 16777215 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return g.push(h(b[0])), g.push(p >> 16 & 255), g.push(p >> 8 & 255), g.push(p & 255), g;
      })() : (c = u.match(t.threeOctet)) ? (function() {
        let b = c.slice(1, 5), g = [];
        if (p = h(b[2]), p > 65535 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return g.push(h(b[0])), g.push(h(b[1])), g.push(p >> 8 & 255), g.push(p & 255), g;
      })() : null;
    }, y.IPv4.subnetMaskFromPrefixLength = function(u) {
      if (u = parseInt(u), Number.isNaN(u) || u < 0 || u > 32)
        throw new Error("ipaddr: invalid IPv4 prefix length");
      let c = [0, 0, 0, 0], m = 0, p = Math.floor(u / 8);
      for (; m < p; )
        c[m] = 255, m++;
      return p < 4 && (c[p] = Math.pow(2, u % 8) - 1 << 8 - u % 8), new this(c);
    }, y.IPv6 = (function() {
      function u(c, m) {
        let p, b;
        if (c.length === 16)
          for (this.parts = [], p = 0; p <= 14; p += 2)
            this.parts.push(c[p] << 8 | c[p + 1]);
        else if (c.length === 8)
          this.parts = c;
        else
          throw new Error("ipaddr: ipv6 part count should be 8 or 16");
        for (p = 0; p < this.parts.length; p++)
          if (b = this.parts[p], !(0 <= b && b <= 65535))
            throw new Error("ipaddr: ipv6 part should fit in 16 bits");
        m && (this.zoneId = m);
      }
      return u.prototype.SpecialRanges = {
        // RFC4291, here and after
        unspecified: [new u([0, 0, 0, 0, 0, 0, 0, 0]), 128],
        linkLocal: [new u([65152, 0, 0, 0, 0, 0, 0, 0]), 10],
        multicast: [new u([65280, 0, 0, 0, 0, 0, 0, 0]), 8],
        loopback: [new u([0, 0, 0, 0, 0, 0, 0, 1]), 128],
        uniqueLocal: [new u([64512, 0, 0, 0, 0, 0, 0, 0]), 7],
        ipv4Mapped: [new u([0, 0, 0, 0, 0, 65535, 0, 0]), 96],
        // RFC3879
        deprecatedSiteLocal: [new u([65216, 0, 0, 0, 0, 0, 0, 0]), 10],
        // RFC6666
        discard: [new u([256, 0, 0, 0, 0, 0, 0, 0]), 64],
        // RFC6145
        rfc6145: [new u([0, 0, 0, 0, 65535, 0, 0, 0]), 96],
        rfc6052: [
          // RFC6052
          [new u([100, 65435, 0, 0, 0, 0, 0, 0]), 96],
          // RFC8215
          [new u([100, 65435, 1, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC3056
        "6to4": [new u([8194, 0, 0, 0, 0, 0, 0, 0]), 16],
        // RFC6052, RFC6146
        teredo: [new u([8193, 0, 0, 0, 0, 0, 0, 0]), 32],
        // RFC5180
        benchmarking: [new u([8193, 2, 0, 0, 0, 0, 0, 0]), 48],
        // RFC7450
        amt: [new u([8193, 3, 0, 0, 0, 0, 0, 0]), 32],
        as112v6: [
          // RFC7535
          [new u([8193, 4, 274, 0, 0, 0, 0, 0]), 48],
          // RFC7534
          [new u([9760, 79, 32768, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC4843
        deprecatedOrchid: [new u([8193, 16, 0, 0, 0, 0, 0, 0]), 28],
        // RFC7343
        orchid2: [new u([8193, 32, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9374
        droneRemoteIdProtocolEntityTags: [new u([8193, 48, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9602
        segmentRouting: [new u([24320, 0, 0, 0, 0, 0, 0, 0]), 16],
        reserved: [
          // RFC3849
          [new u([8193, 0, 0, 0, 0, 0, 0, 0]), 23],
          // RFC2928
          [new u([8193, 3512, 0, 0, 0, 0, 0, 0]), 32],
          // RFC9637
          [new u([16383, 0, 0, 0, 0, 0, 0, 0]), 20]
        ]
      }, u.prototype.isIPv4MappedAddress = function() {
        return this.range() === "ipv4Mapped";
      }, u.prototype.kind = function() {
        return "ipv6";
      }, u.prototype.match = function(c, m) {
        let p;
        if (m === void 0 && (p = c, c = p[0], m = p[1]), c.kind() !== "ipv6")
          throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
        return d(this.parts, c.parts, 16, m);
      }, u.prototype.prefixLengthFromSubnetMask = function() {
        let c = 0, m = !1, p = {
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
        }, b, g;
        for (let x = 7; x >= 0; x -= 1)
          if (b = this.parts[x], b in p) {
            if (g = p[b], m && g !== 0)
              return null;
            g !== 16 && (m = !0), c += g;
          } else
            return null;
        return 128 - c;
      }, u.prototype.range = function() {
        return y.subnetMatch(this, this.SpecialRanges);
      }, u.prototype.toByteArray = function() {
        let c, m = [], p = this.parts;
        for (let b = 0; b < p.length; b++)
          c = p[b], m.push(c >> 8), m.push(c & 255);
        return m;
      }, u.prototype.toFixedLengthString = function() {
        let c = (function() {
          let p = [];
          for (let b = 0; b < this.parts.length; b++)
            p.push(f(this.parts[b].toString(16), 4));
          return p;
        }).call(this).join(":"), m = "";
        return this.zoneId && (m = `%${this.zoneId}`), c + m;
      }, u.prototype.toIPv4Address = function() {
        if (!this.isIPv4MappedAddress())
          throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
        let c = this.parts.slice(-2), m = c[0], p = c[1];
        return new y.IPv4([m >> 8, m & 255, p >> 8, p & 255]);
      }, u.prototype.toNormalizedString = function() {
        let c = (function() {
          let p = [];
          for (let b = 0; b < this.parts.length; b++)
            p.push(this.parts[b].toString(16));
          return p;
        }).call(this).join(":"), m = "";
        return this.zoneId && (m = `%${this.zoneId}`), c + m;
      }, u.prototype.toRFC5952String = function() {
        let c = /((^|:)(0(:|$)){2,})/g, m = "";
        this.zoneId && (m = `%${this.zoneId}`);
        let p = this.toNormalizedString(), b = p.slice(0, p.length - m.length), g = 0, x = -1, w = -1, k;
        for (; k = c.exec(b); ) {
          let C = (k[0].match(/0/g) || []).length;
          C > w && (w = C, g = k.index, x = k[0].length);
        }
        return x < 0 ? b + m : `${b.substring(0, g)}::${b.substring(g + x)}${m}`;
      }, u.prototype.toString = function() {
        return this.toRFC5952String();
      }, u;
    })(), y.IPv6.broadcastAddressFromCIDR = function(u) {
      try {
        let c = this.parseCIDR(u), m = c[0].toByteArray(), p = this.subnetMaskFromPrefixLength(c[1]).toByteArray(), b = [], g = 0;
        for (; g < 16; )
          b.push(parseInt(m[g], 10) | parseInt(p[g], 10) ^ 255), g++;
        return new this(b);
      } catch (c) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: c });
      }
    }, y.IPv6.isIPv6 = function(u) {
      return this.parser(u) !== null;
    }, y.IPv6.isValid = function(u) {
      if (typeof u == "string" && u.indexOf(":") === -1)
        return !1;
      try {
        let c = this.parser(u);
        return new this(c.parts, c.zoneId), !0;
      } catch {
        return !1;
      }
    }, y.IPv6.isValidCIDR = function(u) {
      if (typeof u == "string" && u.indexOf(":") === -1)
        return !1;
      try {
        return this.parseCIDR(u), !0;
      } catch {
        return !1;
      }
    }, y.IPv6.networkAddressFromCIDR = function(u) {
      let c, m, p, b, g;
      try {
        for (c = this.parseCIDR(u), p = c[0].toByteArray(), g = this.subnetMaskFromPrefixLength(c[1]).toByteArray(), b = [], m = 0; m < 16; )
          b.push(parseInt(p[m], 10) & parseInt(g[m], 10)), m++;
        return new this(b);
      } catch (x) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: x });
      }
    }, y.IPv6.parse = function(u) {
      let c = this.parser(u);
      if (c === null)
        throw new Error("ipaddr: string is not formatted like an IPv6 Address");
      return new this(c.parts, c.zoneId);
    }, y.IPv6.parseCIDR = function(u) {
      let c, m, p;
      if ((m = u.match(/^(.+)\/(\d+)$/)) && (c = parseInt(m[2]), c >= 0 && c <= 128))
        return p = [this.parse(m[1]), c], Object.defineProperty(p, "toString", {
          value: function() {
            return this.join("/");
          }
        }), p;
      throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
    }, y.IPv6.parser = function(u) {
      let c, m, p, b, g, x;
      if (p = u.match(a.deprecatedTransitional))
        return this.parser(`::ffff:${p[1]}`);
      if (a.native.test(u))
        return l(u, 8);
      if ((p = u.match(a.transitional)) && (x = p[6] || "", c = p[1], p[1].endsWith("::") || (c = c.slice(0, -1)), c = l(c + x, 6), c && c.parts)) {
        for (g = [
          parseInt(p[2]),
          parseInt(p[3]),
          parseInt(p[4]),
          parseInt(p[5])
        ], m = 0; m < g.length; m++)
          if (b = g[m], !(0 <= b && b <= 255))
            return null;
        return c.parts.push(g[0] << 8 | g[1]), c.parts.push(g[2] << 8 | g[3]), {
          parts: c.parts,
          zoneId: c.zoneId
        };
      }
      return null;
    }, y.IPv6.subnetMaskFromPrefixLength = function(u) {
      if (u = parseInt(u), Number.isNaN(u) || u < 0 || u > 128)
        throw new Error("ipaddr: invalid IPv6 prefix length");
      let c = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], m = 0, p = Math.floor(u / 8);
      for (; m < p; )
        c[m] = 255, m++;
      return p < 16 && (c[p] = Math.pow(2, u % 8) - 1 << 8 - u % 8), new this(c);
    }, y.fromByteArray = function(u) {
      let c = u.length;
      if (c === 4)
        return new y.IPv4(u);
      if (c === 16)
        return new y.IPv6(u);
      throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
    }, y.isValid = function(u) {
      return y.IPv6.isValid(u) || y.IPv4.isValid(u);
    }, y.isValidCIDR = function(u) {
      return y.IPv6.isValidCIDR(u) || y.IPv4.isValidCIDR(u);
    }, y.parse = function(u) {
      if (y.IPv6.isValid(u))
        return y.IPv6.parse(u);
      if (y.IPv4.isValid(u))
        return y.IPv4.parse(u);
      throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
    }, y.parseCIDR = function(u) {
      try {
        return y.IPv6.parseCIDR(u);
      } catch {
        try {
          return y.IPv4.parseCIDR(u);
        } catch (c) {
          throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: c });
        }
      }
    }, y.process = function(u) {
      let c = this.parse(u);
      return c.kind() === "ipv6" && c.isIPv4MappedAddress() ? c.toIPv4Address() : c;
    }, y.subnetMatch = function(u, c, m) {
      let p, b, g, x;
      m == null && (m = "unicast");
      for (b in c)
        if (Object.prototype.hasOwnProperty.call(c, b)) {
          for (g = c[b], g[0] && !(g[0] instanceof Array) && (g = [g]), p = 0; p < g.length; p++)
            if (x = g[p], u.kind() === x[0].kind() && u.match.apply(u, x))
              return b;
        }
      return m;
    }, typeof Pe < "u" && Pe.exports ? Pe.exports = y : e.ipaddr = y;
  })(Jt);
});

// openclaw/packages/normalization-core/src/record-coerce.ts
function z(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function P(e) {
  return z(e) ? e : void 0;
}
function N(e) {
  return z(e) ? e : null;
}
function Ne(e) {
  return e && typeof e == "object" ? e : void 0;
}
function V(e) {
  return Ne(e) ?? null;
}

// openclaw/ui/src/components/browser/browser-target.ts
function Le(e, n = 128) {
  return typeof e == "string" && e.length > 0 && e.length <= n && e.trim() === e;
}
function mn(e) {
  let n = N(e);
  if (!Le(n?.targetId) || !Le(n.profile))
    return;
  let t = { targetId: n.targetId, profile: n.profile };
  if (n.target === "host" && n.node === void 0)
    return { ...t, target: "host" };
  if (n.target === "node" && Le(n.node, 256))
    return { ...t, target: "node", node: n.node };
}
function yn(e) {
  return JSON.stringify([e.target, e.node, e.profile, e.targetId]);
}

// openclaw/packages/normalization-core/src/string-coerce.ts
function O(e) {
  if (typeof e != "string")
    return null;
  let n = e.trim();
  return n || null;
}
function B(e) {
  return O(e) ?? void 0;
}
function S(e) {
  return typeof e == "string" && e.trim() ? e : void 0;
}

// openclaw/packages/normalization-core/src/number-coercion.ts
function Y(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
var Sr = 2147e6, oa = Math.floor(Sr / 1e3);

// openclaw/packages/gateway-client/src/session-projection-message-identity.ts
function bn(e) {
  return typeof e == "number" && Number.isSafeInteger(e) && e > 0 ? e : null;
}
function xn(e, n) {
  let t = N(N(e)?.__openclaw);
  return bn(t?.seq) ?? bn(n?.messageSeq);
}
function ae(e) {
  let n = O(e);
  return n?.endsWith(":user") ? n.slice(0, -5) || null : n;
}
function Be(e, n) {
  let t = N(e), o = O(t?.role)?.toLowerCase();
  if (!t || !o)
    return null;
  let r = N(t.__openclaw), i = O(r?.importedFrom), s = O(r?.cliSessionId), a = O(r?.externalId), l = N(r?.transcriptPosition), d = O(l?.source), f = !(d !== null && d.length <= 128 && typeof l?.rawSeq == "number" && Number.isSafeInteger(l.rawSeq) && l.rawSeq >= 0) && !!(i || s || a), y = O(r?.idempotencyKey) ?? O(t.idempotencyKey) ?? O(n?.idempotencyKey) ?? O(n?.clientRunId), u = ae(y), c = ae(n?.runId), m = ae(r?.runId), p = ae(
    N(t.openclawStreamFallback)?.runId
  ), b = O(r?.mirrorOrigin) !== null, g = o === "assistant" && O(t.api)?.toLowerCase() === "cli", x = g && u?.startsWith("cli-assistant:") ? O(u.slice(14)) : u, w = o === "assistant" ? m ?? c ?? p ?? (g || !b ? x : null) : m ?? x ?? c;
  return {
    role: o,
    id: O(r?.id) ?? O(n?.messageId),
    sequence: xn(e, n),
    idempotencyKey: y,
    sendId: o === "user" ? u ?? w : null,
    runId: w,
    isImported: f,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource: f && i && s && a ? JSON.stringify([i, s, a]) : null
  };
}

// openclaw/packages/normalization-core/src/error-coercion.ts
var Ar = /* @__PURE__ */ Symbol.for(
  "openclaw.provider-auth-persistence-error"
), kn, Cn, wn = class extends (Cn = AggregateError, kn = Ar, Cn) {
  constructor(t, o, { cause: r }) {
    super([o, r], t, { cause: r });
    this[kn] = !0;
    this.persistenceError = o, this.cleanupError = r;
  }
};

// openclaw/packages/normalization-core/src/json-coercion.ts
function Ue(e) {
  try {
    return JSON.parse(e);
  } catch {
    return;
  }
}
function Z(e) {
  return /^[\t\n\r ]*\{/.test(e) ? P(Ue(e)) : void 0;
}

// openclaw/src/chat/canvas-render.ts
function Er(e) {
  let n = S(e?.viewId);
  if (!n || n.length > 128)
    return;
  let t = S(e?.serverName), o = S(e?.toolName), r = S(e?.uiResourceUri), i = S(e?.toolCallId), s = S(e?.originSessionKey), a = e?.resultMetaState === "unavailable" ? "unavailable" : void 0;
  return !!(t && t.length <= 256 && o && o.length <= 256 && r?.startsWith("ui://") && r.length <= 2048 && i && i.length <= 512) ? {
    viewId: n,
    serverName: t,
    toolName: o,
    uiResourceUri: r,
    toolCallId: i,
    ...s && s.length <= 512 ? { originSessionKey: s } : {},
    ...a ? { resultMetaState: a } : {}
  } : { viewId: n };
}
function vr(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 160 ? Math.min(Math.trunc(e), 1200) : void 0;
}
function _n(e) {
  return typeof e == "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(e);
}
function Tn(e) {
  let n = P(e);
  if (!n || S(n?.kind)?.trim().toLowerCase() !== "canvas")
    return;
  let o = P(n.presentation), r = P(n.view), i = P(n.source), s = Er(P(n.mcpApp)), a = s?.viewId, d = S(o?.target) ?? S(n?.target) ?? "assistant_message";
  if (d !== "assistant_message" && d !== "node_panel")
    return;
  let h = S(o?.title) ?? S(r?.title), f = vr(
    Y(o?.preferred_height) ?? Y(o?.preferredHeight) ?? Y(r?.preferred_height) ?? Y(r?.preferredHeight)
  ), y = S(o?.class_name) ?? S(o?.className), u = S(o?.style), c = S(o?.sandbox), m = S(r?.url) ?? S(r?.entryUrl), p = S(r?.id) ?? S(r?.docId), b = S(r?.boardWidgetName), g = _n(b) ? b : void 0, x = {
    kind: "canvas",
    surface: d,
    render: "url",
    ...h ? { title: h } : {},
    ...f ? { preferredHeight: f } : {},
    ...c === "strict" || c === "scripts" ? { sandbox: c } : {},
    ...s ? { mcpApp: s } : {}
  };
  if (a && p === a)
    return { ...x, viewId: p };
  let w = m ?? (S(i?.type)?.trim().toLowerCase() === "url" ? S(i?.url) : void 0);
  if (w)
    return {
      ...x,
      url: w,
      ...m && p ? { viewId: p } : {},
      ...y ? { className: y } : {},
      ...u ? { style: u } : {},
      ...m && g ? { boardWidgetName: g } : {}
    };
}
function In(e) {
  let n = P(e);
  return Tn(n?.mcpAppPreview);
}
function Sn(e) {
  let n = e ? Z(e) : void 0;
  return Tn(n);
}

// openclaw/src/chat/tool-content.ts
var Mr = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId"
];
function An(e) {
  return typeof e == "string" ? e.toLowerCase() : "";
}
function je(e) {
  let n = An(e);
  return n === "toolcall" || n === "tool_call" || n === "tooluse" || n === "tool_use";
}
function we(e) {
  let n = An(e);
  return n === "toolresult" || n === "tool_result";
}
function En(e) {
  for (let n of Mr) {
    let t = B(e[n]);
    if (t)
      return t;
  }
}
function ke(e) {
  let n = e.isError ?? e.is_error;
  return typeof n == "boolean" ? n : void 0;
}
var Dr = /^tool not found\.?$/i, Pr = 2e4, Or = /* @__PURE__ */ new Set(["error", "failed", "timeout"]);
function Fr(e) {
  return typeof e == "string" && Or.has(e.trim().toLowerCase());
}
function vn(e) {
  let n = e?.trim();
  if (!n)
    return !1;
  if (Dr.test(n))
    return !0;
  if (n.length > Pr || !n.startsWith("{") || !n.endsWith("}"))
    return !1;
  let t = Z(n);
  if (!t)
    return !1;
  let o = ke(t);
  if (o !== void 0)
    return o;
  if ("error" in t) {
    let r = t.error;
    if (typeof r == "string")
      return r.trim().length > 0;
    if (typeof r == "boolean")
      return r;
    if (r && typeof r == "object")
      return !0;
  }
  return Fr(t.status);
}

// openclaw/ui/src/lib/chat/message-derivations.ts
var Mn = /* @__PURE__ */ new WeakMap();
function ze(e) {
  let n = Mn.get(e);
  return n || (n = {
    revision: void 0,
    normalized: void 0,
    toolCards: void 0
  }, Mn.set(e, n)), n;
}

// openclaw/packages/session-url-contract/src/share.ts
var Br = Object.freeze([
  "activity",
  "ai-agents",
  "appearance",
  "approve",
  "apps",
  "ask",
  "automation",
  "automations",
  "channels",
  "chat",
  "templates",
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

// openclaw/src/shared/regexp.ts
function re(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// openclaw/src/plugin-sdk/message-tool-delivery-hints.ts
var Ur = "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.", jr = "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.", $e = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  Ur,
  jr
];

// openclaw/src/auto-reply/reply/inbound-context-marker.ts
var We = "\u27E6openclaw:ctx\u27E7";

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
var rc = `Context: ${We}`;
var zr = [We, ...$e], oc = new RegExp(zr.map(re).join("|"), "g");

// openclaw/packages/llm-core/src/types.ts
var Fn = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", Nn = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", Ln = "OpenClaw runtime context:", Bn = "End OpenClaw runtime context.";

// openclaw/src/agents/internal-runtime-context.ts
var qr = Fn, Gr = Nn;
var Un = "This context is runtime-generated, not user-authored. Keep internal details private.";
var Sc = ["OpenClaw runtime context (internal):", Un, ""].join(`
`) + `
`;
function Ce(e) {
  return {
    token: e,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${re(e)}[ \\t]*(?=\\r?\\n|$)`, "g")
  };
}
var Ac = Ce(qr), Ec = Ce(Gr), vc = Ce(Ln), Mc = Ce(Bn);
var Jr = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event."
], Kr = new RegExp(
  Jr.flatMap((e) => {
    let n = e.split(". ");
    return n.map((t, o) => n.slice(o).join(". "));
  }).map((e) => e.split(/\s+/).map(re).join("\\s+")).join("|")
), Hr = new RegExp(
  Un.split(/\s+/).map(re).join("\\s+")
), Dc = new RegExp(
  `^[ \\t]*(?:${Kr.source})\\s+${Hr.source}[ \\t]*(?:\\r?\\n|$)`,
  "gm"
);

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/index.mjs
var Ge = {};
gn(Ge, {
  decode: () => le,
  encode: () => J,
  format: () => oe,
  parse: () => de
});

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/decode.mjs
var zn = {};
function Vr(e) {
  let n = zn[e];
  if (n)
    return n;
  n = zn[e] = [];
  for (let t = 0; t < 128; t++) {
    let o = String.fromCharCode(t);
    n.push(o);
  }
  for (let t = 0; t < e.length; t++) {
    let o = e.charCodeAt(t);
    n[o] = "%" + ("0" + o.toString(16).toUpperCase()).slice(-2);
  }
  return n;
}
function Re(e, n) {
  typeof n != "string" && (n = Re.defaultChars);
  let t = Vr(n);
  return e.replace(/(%[a-f0-9]{2})+/gi, function(o) {
    let r = "";
    for (let i = 0, s = o.length; i < s; i += 3) {
      let a = parseInt(o.slice(i + 1, i + 3), 16);
      if (a < 128) {
        r += t[a];
        continue;
      }
      if ((a & 224) === 192 && i + 3 < s) {
        let l = parseInt(o.slice(i + 4, i + 6), 16);
        if ((l & 192) === 128) {
          let d = a << 6 & 1984 | l & 63;
          d < 128 ? r += "\uFFFD\uFFFD" : r += String.fromCharCode(d), i += 3;
          continue;
        }
      }
      if ((a & 240) === 224 && i + 6 < s) {
        let l = parseInt(o.slice(i + 4, i + 6), 16), d = parseInt(o.slice(i + 7, i + 9), 16);
        if ((l & 192) === 128 && (d & 192) === 128) {
          let h = a << 12 & 61440 | l << 6 & 4032 | d & 63;
          h < 2048 || h >= 55296 && h <= 57343 ? r += "\uFFFD\uFFFD\uFFFD" : r += String.fromCharCode(h), i += 6;
          continue;
        }
      }
      if ((a & 248) === 240 && i + 9 < s) {
        let l = parseInt(o.slice(i + 4, i + 6), 16), d = parseInt(o.slice(i + 7, i + 9), 16), h = parseInt(o.slice(i + 10, i + 12), 16);
        if ((l & 192) === 128 && (d & 192) === 128 && (h & 192) === 128) {
          let f = a << 18 & 1835008 | l << 12 & 258048 | d << 6 & 4032 | h & 63;
          f < 65536 || f > 1114111 ? r += "\uFFFD\uFFFD\uFFFD\uFFFD" : (f -= 65536, r += String.fromCharCode(55296 + (f >> 10), 56320 + (f & 1023))), i += 9;
          continue;
        }
      }
      r += "\uFFFD";
    }
    return r;
  });
}
Re.defaultChars = ";/?:@&=+$,#";
Re.componentChars = "";
var le = Re;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/encode.mjs
var $n = {};
function Yr(e) {
  let n = $n[e];
  if (n)
    return n;
  n = $n[e] = [];
  for (let t = 0; t < 128; t++) {
    let o = String.fromCharCode(t);
    /^[0-9a-z]$/i.test(o) ? n.push(o) : n.push("%" + ("0" + t.toString(16).toUpperCase()).slice(-2));
  }
  for (let t = 0; t < e.length; t++)
    n[e.charCodeAt(t)] = e[t];
  return n;
}
function _e(e, n, t) {
  typeof n != "string" && (t = n, n = _e.defaultChars), typeof t > "u" && (t = !0);
  let o = Yr(n), r = "";
  for (let i = 0, s = e.length; i < s; i++) {
    let a = e.charCodeAt(i);
    if (t && a === 37 && i + 2 < s && /^[0-9a-f]{2}$/i.test(e.slice(i + 1, i + 3))) {
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
_e.defaultChars = ";/?:@&=+$,-_.!~*'()#";
_e.componentChars = "-_.!~*'()";
var J = _e;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/format.mjs
function oe(e) {
  let n = "";
  return n += e.protocol || "", n += e.slashes ? "//" : "", n += e.auth ? e.auth + "@" : "", e.hostname && e.hostname.indexOf(":") !== -1 ? n += "[" + e.hostname + "]" : n += e.hostname || "", n += e.port ? ":" + e.port : "", n += e.pathname || "", n += e.search || "", n += e.hash || "", n;
}

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/parse.mjs
function Te() {
  this.protocol = null, this.slashes = null, this.auth = null, this.port = null, this.hostname = null, this.hash = null, this.search = null, this.pathname = null;
}
var Zr = /^([a-z0-9.+-]+:)/i, Qr = /:[0-9]*$/, eo = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/, no = ["<", ">", '"', "`", " ", "\r", `
`, "	"], to = ["{", "}", "|", "\\", "^", "`"].concat(no), ro = ["'"].concat(to), Wn = ["%", "/", "?", ";", "#"].concat(ro), qn = ["/", "?", "#"], oo = 255, Gn = /^[+a-z0-9A-Z_-]{0,63}$/, io = /^([+a-z0-9A-Z_-]{0,63})(.*)$/, Jn = {
  javascript: !0,
  "javascript:": !0
}, Kn = {
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
function so(e, n) {
  if (e && e instanceof Te) return e;
  let t = new Te();
  return t.parse(e, n), t;
}
Te.prototype.parse = function(e, n) {
  let t, o, r, i = e;
  if (i = i.trim(), !n && e.split("#").length === 1) {
    let d = eo.exec(i);
    if (d)
      return this.pathname = d[1], d[2] && (this.search = d[2]), this;
  }
  let s = Zr.exec(i);
  if (s && (s = s[0], t = s.toLowerCase(), this.protocol = s, i = i.substr(s.length)), (n || s || i.match(/^\/\/[^@\/]+@[^@\/]+/)) && (r = i.substr(0, 2) === "//", r && !(s && Jn[s]) && (i = i.substr(2), this.slashes = !0)), !Jn[s] && (r || s && !Kn[s])) {
    let d = -1;
    for (let c = 0; c < qn.length; c++)
      o = i.indexOf(qn[c]), o !== -1 && (d === -1 || o < d) && (d = o);
    let h, f;
    d === -1 ? f = i.lastIndexOf("@") : f = i.lastIndexOf("@", d), f !== -1 && (h = i.slice(0, f), i = i.slice(f + 1), this.auth = h), d = -1;
    for (let c = 0; c < Wn.length; c++)
      o = i.indexOf(Wn[c]), o !== -1 && (d === -1 || o < d) && (d = o);
    d === -1 && (d = i.length), i[d - 1] === ":" && d--;
    let y = i.slice(0, d);
    i = i.slice(d), this.parseHost(y), this.hostname = this.hostname || "";
    let u = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
    if (!u) {
      let c = this.hostname.split(/\./);
      for (let m = 0, p = c.length; m < p; m++) {
        let b = c[m];
        if (b && !b.match(Gn)) {
          let g = "";
          for (let x = 0, w = b.length; x < w; x++)
            b.charCodeAt(x) > 127 ? g += "x" : g += b[x];
          if (!g.match(Gn)) {
            let x = c.slice(0, m), w = c.slice(m + 1), k = b.match(io);
            k && (x.push(k[1]), w.unshift(k[2])), w.length && (i = w.join(".") + i), this.hostname = x.join(".");
            break;
          }
        }
      }
    }
    this.hostname.length > oo && (this.hostname = ""), u && (this.hostname = this.hostname.substr(1, this.hostname.length - 2));
  }
  let a = i.indexOf("#");
  a !== -1 && (this.hash = i.substr(a), i = i.slice(0, a));
  let l = i.indexOf("?");
  return l !== -1 && (this.search = i.substr(l), i = i.slice(0, l)), i && (this.pathname = i), Kn[t] && this.hostname && !this.pathname && (this.pathname = ""), this;
};
Te.prototype.parseHost = function(e) {
  let n = Qr.exec(e);
  n && (n = n[0], n !== ":" && (this.port = n.substr(1)), e = e.substr(0, e.length - n.length)), e && (this.hostname = e);
};
var de = so;

// openclaw/node_modules/.pnpm/uc.micro@3.0.0/node_modules/uc.micro/build/index.mjs
var Ve = {};
gn(Ve, {
  Any: () => Je,
  Cc: () => Ke,
  Cf: () => ao,
  P: () => pe,
  S: () => He,
  Z: () => Xe
});
var Je = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/, Ke = /[\0-\x1F\x7F-\x9F]/, ao = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/, pe = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/, He = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/, Xe = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode-codepoint.js
var uo = [
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
function co(e) {
  return e === 0 || e >= 55296 && e <= 57343 || e > 1114111;
}
function Hn(e) {
  return co(e) ? 65533 : e >= 128 && e <= 159 && uo[e - 128] || e;
}
function Xn(e) {
  return e - 1 >>> 0 < 127 || e - 160 >>> 0 < 55136 ? String.fromCharCode(e) : String.fromCodePoint(Hn(e));
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/decode-shared.js
var $ = /* @__PURE__ */ (() => {
  let e = new Uint8Array(127), n = 0;
  for (let t = 33; t <= 126; t++)
    t !== 34 && t !== 36 && t !== 92 && (e[t] = n++);
  return e;
})();
function Vn(e, n, t, o, r, i) {
  let a = e.length, l = i * 90, d = 0, h = () => {
    let T = $[e.charCodeAt(d++)];
    return T < i ? T : T * 91 - l + $[e.charCodeAt(d++)];
  }, f = t - o, y = t + r, u = new Int32Array(y);
  u.fill(-1, o, i), u.fill(-1, i + f, y);
  let c = new Int32Array(y), m = new Int32Array(y);
  function p(T, M) {
    let I = 0, D = M, j = M + T;
    for (; D < j; ) {
      let L = $[e.charCodeAt(d++)];
      if (L < 89)
        I += L, u[D++] = I;
      else if (L === 89) {
        let v = $[e.charCodeAt(d++)] + 2;
        for (; v--; )
          u[D++] = ++I;
      } else {
        let v = $[e.charCodeAt(d++)];
        I += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        (v < 90 ? v * 91 + $[e.charCodeAt(d++)] : $[e.charCodeAt(d++)] * 8281 + $[e.charCodeAt(d++)] * 91 + $[e.charCodeAt(d++)]), u[D++] = I;
      }
    }
  }
  p(o, 0), p(f, i);
  let b = new Int32Array(r * 2), g = 0, x = 0;
  function w(T, M) {
    for (let I = 0; I < T; I++) {
      let D = M + I, j = h(), L = h();
      b[x * 2] = j, b[x * 2 + 1] = L, x += 1, c[D] = g;
      let v = (u[j] < 0 ? m[j] : 1) + (u[L] < 0 ? m[L] : 1);
      m[D] = v, g += v;
    }
  }
  w(r - i + o, i + f), w(i - o, o);
  let k = new Uint16Array(g), C = 0;
  for (let T = 0; T < x; T++)
    for (let M = 0; M < 2; M++) {
      let I = b[T * 2 + M], D = u[I];
      if (D < 0) {
        let j = c[I], L = j + m[I];
        for (; j < L; )
          k[C++] = k[j++];
      } else
        k[C++] = D;
    }
  let _ = new Uint16Array(n), A = 0;
  for (; d < a; ) {
    let T = $[e.charCodeAt(d++)];
    T >= i && (T = T * 91 - l + $[e.charCodeAt(d++)]);
    let M = u[T];
    if (M < 0) {
      let I = c[T], D = I + m[T];
      for (; I < D; )
        _[A++] = k[I++];
    } else
      _[A++] = M;
  }
  return _;
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/generated/decode-data-html.js
var Yn = /* @__PURE__ */ Vn("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/bin-trie-flags.js
var F;
(function(e) {
  e[e.VALUE_LENGTH = 49152] = "VALUE_LENGTH", e[e.FLAG13 = 8192] = "FLAG13", e[e.BRANCH_LENGTH = 8064] = "BRANCH_LENGTH", e[e.JUMP_TABLE = 127] = "JUMP_TABLE", e[e.VALUE_MASK = 8191] = "VALUE_MASK";
})(F || (F = {}));

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode.js
var U;
(function(e) {
  e[e.AMP = 38] = "AMP", e[e.NUM = 35] = "NUM", e[e.SEMI = 59] = "SEMI", e[e.EQUALS = 61] = "EQUALS", e[e.ZERO = 48] = "ZERO", e[e.NINE = 57] = "NINE", e[e.LOWER_A = 97] = "LOWER_A", e[e.LOWER_X = 120] = "LOWER_X";
})(U || (U = {}));
var Ie = 32, et = 21, lo = 2097151, Ye = 2047, nt = 0;
function po(e) {
  let n = e >>> et;
  return n === Ye ? nt : n;
}
function tt(e) {
  return e - U.ZERO >>> 0 <= 9;
}
function fo(e) {
  return (e | Ie) - U.LOWER_A >>> 0 <= 5;
}
function rt(e) {
  return (e | Ie) - U.LOWER_A >>> 0 <= 25;
}
function go(e) {
  return e === U.EQUALS || rt(e) || tt(e);
}
var Zn;
(function(e) {
  e[e.EntityStart = 0] = "EntityStart", e[e.NumericStart = 1] = "NumericStart", e[e.NumericDecimal = 2] = "NumericDecimal", e[e.NumericHex = 3] = "NumericHex", e[e.NamedEntity = 4] = "NamedEntity";
})(Zn || (Zn = {}));
var Ze;
(function(e) {
  e[e.Legacy = 0] = "Legacy", e[e.Strict = 1] = "Strict", e[e.Attribute = 2] = "Attribute";
})(Ze || (Ze = {}));
function ho(e, n, t, o) {
  let r = (n & F.BRANCH_LENGTH) >> 7, i = n & F.JUMP_TABLE;
  if (i) {
    if (r === 0)
      return o === i ? t : -1;
    let l = o - i;
    if (l >>> 0 >= r)
      return -1;
    let d = e[t + l];
    return d === 0 ? -1 : t + r + d - 1 & 65535;
  }
  if (r === 0)
    return -1;
  let s = r + 1 >> 1, a = t + s + r;
  for (let l = 0; l < r; l++) {
    let h = e[t + (l >> 1)] >> ((l & 1) << 3) & 255;
    if (h === o) {
      let f = t + s + l;
      return a + e[f] & 65535;
    }
    if (h > o)
      return -1;
  }
  return -1;
}
function Qn(e, n, t) {
  return t === 1 ? String.fromCharCode(e[n] & F.VALUE_MASK) : t === 2 ? String.fromCharCode(e[n + 1]) : String.fromCharCode(e[n + 1], e[n + 2]);
}
function mo(e, n, t) {
  let o = n + 1, r = 0, i = o;
  if (o < t && (e.charCodeAt(o) | Ie) === U.LOWER_X)
    for (o += 1, i = o; o < t; ) {
      let a = e.charCodeAt(o);
      if (tt(a))
        r = r * 16 + (a - U.ZERO);
      else if (fo(a))
        r = r * 16 + ((a | Ie) - U.LOWER_A + 10);
      else
        break;
      o += 1;
    }
  else
    for (; o < t; ) {
      let a = e.charCodeAt(o) - U.ZERO;
      if (a >>> 0 > 9)
        break;
      r = r * 10 + a, o += 1;
    }
  if (o === i)
    return 0;
  o < t && e.charCodeAt(o) === U.SEMI && (o += 1), r > 1114111 && (r = 1114112);
  let s = o - n;
  return s >= Ye && (nt = s, s = Ye), s << et | r;
}
function yo(e, n, t) {
  let o = Yn, r = e.indexOf("&");
  if (r < 0)
    return e;
  let i = e.length, s = 0, a = "", l = o[0], d = l & F.JUMP_TABLE, h = (l & F.BRANCH_LENGTH) >> 7;
  do {
    let f = r + 1, y = e.charCodeAt(f), u, c;
    if (y === U.NUM) {
      let m = mo(e, f, i);
      u = po(m), n && u > 0 && e.charCodeAt(f + u - 1) !== U.SEMI && (u = 0), c = u === 0 ? "" : Xn(m & lo);
    } else if (rt(y)) {
      u = 0, c = "";
      let m = y - d, p;
      if (m >>> 0 < h) {
        let k = o[1 + m];
        p = k === 0 ? -1 : h + k & 65535;
      } else
        p = -1;
      let b = 0, g = 0, x = p < 0 ? 0 : o[p], w = f + 1;
      e: for (; w < i; ) {
        for (
          ;
          // Value-less, non-run node with a nonzero jump offset.
          (x & (F.VALUE_LENGTH | F.FLAG13)) === 0 && (x & F.JUMP_TABLE) !== 0;
        ) {
          let A = x & F.JUMP_TABLE, T = (x & F.BRANCH_LENGTH) >> 7;
          if (T === 0) {
            if (e.charCodeAt(w) !== A)
              break e;
            p += 1;
          } else {
            let M = e.charCodeAt(w) - A;
            if (M >>> 0 >= T)
              break e;
            let I = o[p + 1 + M];
            if (I === 0)
              break e;
            p = p + T + I & 65535;
          }
          if (x = o[p], w += 1, w >= i)
            break e;
        }
        if ((x & (F.VALUE_LENGTH | F.FLAG13)) === F.FLAG13) {
          let A = (x & F.BRANCH_LENGTH) >> 7;
          if (e.charCodeAt(w) !== (x & F.JUMP_TABLE))
            break;
          w += 1;
          let T = A - 1, M = p + 1, I = 0;
          for (; I + 1 < T; I += 2) {
            let D = o[M];
            if (e.charCodeAt(w) !== (D & 255) || (w += 1, e.charCodeAt(w) !== (D >> 8 & 255)))
              break e;
            w += 1, M += 1;
          }
          if (I < T) {
            if (e.charCodeAt(w) !== (o[M] & 255))
              break;
            w += 1;
          }
          p += 1 + (A >> 1), x = o[p];
          continue;
        }
        let k = x >>> 14, C = e.charCodeAt(w);
        if (k !== 0) {
          if (C === U.SEMI) {
            u = w - f + 1, c = k === 1 ? String.fromCharCode(x & F.VALUE_MASK) : Qn(o, p, k);
            break;
          }
          if (!n && (x & F.FLAG13) === 0 && (u = w - f, b = p, g = k), k === 1)
            break;
        }
        let _ = ho(o, x, p + (k || 1), C);
        if (_ < 0)
          break;
        p = _, x = o[p], w += 1;
      }
      if (c === "") {
        let k = x >>> 14;
        k !== 0 && !n && (x & F.FLAG13) === 0 && (u = w - f, b = p, g = k), u > 0 && (c = Qn(o, b, g));
      }
    } else
      u = 0, c = "";
    u === 0 || t && y !== U.NUM && e.charCodeAt(f + u - 1) !== U.SEMI && f + u < i && go(e.charCodeAt(f + u)) ? r = f : (s < r && (a += e.slice(s, r)), a += c, r = s = f + u), e.charCodeAt(r) !== U.AMP && (r = e.indexOf("&", r));
  } while (r >= 0);
  return a + e.slice(s);
}
function Se(e) {
  return yo(e, !0, !1);
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/index.js
var ot;
(function(e) {
  e[e.XML = 0] = "XML", e[e.HTML = 1] = "HTML";
})(ot || (ot = {}));
var it;
(function(e) {
  e[e.UTF8 = 0] = "UTF8", e[e.ASCII = 1] = "ASCII", e[e.Extensive = 2] = "Extensive", e[e.Attribute = 3] = "Attribute", e[e.Text = 4] = "Text";
})(it || (it = {}));

// openclaw/node_modules/.pnpm/linkify-it@6.1.0/node_modules/linkify-it/build/index.mjs
var xo = class {
  src_Any = Je.source;
  src_Cc = Ke.source;
  src_Z = Xe.source;
  src_P = pe.source;
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
  nestedPairRE(e, n, t = 4) {
    let o = this.escapeRE(e), r = this.escapeRE(n), i = `(?:(?!${this.src_ZCc}|${o}|${r}).)`, s = `${o}${i}{0,1000}${r}`;
    for (let a = 2; a <= t; a++) s = `${o}(?:${i}|${s}){0,1000}${r}`;
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
    let e = "[0-9A-Fa-f]{1,4}", n = `(?:(?:${e}:${e})|${this.get_ipv4_addr().source})`;
    return this.cache.src_ip6_addr ??= new RegExp(`(?:(?:${e}:){6}${n}|::(?:${e}:){5}${n}|(?:${e})?::(?:${e}:){4}${n}|(?:(?:${e}:){0,1}${e})?::(?:${e}:){3}${n}|(?:(?:${e}:){0,2}${e})?::(?:${e}:){2}${n}|(?:(?:${e}:){0,3}${e})?::${e}:${n}|(?:(?:${e}:){0,4}${e})?::${n}|(?:(?:${e}:){0,5}${e})?::${e}|(?:(?:${e}:){0,6}${e})?::)`);
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
}, Qe = {
  validate: (e, n, t) => {
    let o = t.re.get_http_validator();
    o.lastIndex = n;
    let r = o.exec(e);
    return r ? r[0].length : 0;
  },
  normalize: (e, n) => n.normalize(e)
}, wo = {
  "http:": Qe,
  "https:": Qe,
  "ftp:": Qe,
  "//": {
    validate: function(e, n, t) {
      let o = t.re.get_relative_proto_validator();
      o.lastIndex = n;
      let r = o.exec(e);
      return r ? n >= 3 && e[n - 3] === ":" || n >= 3 && e[n - 3] === "/" ? 0 : r[0].length : 0;
    },
    normalize: (e, n) => n.normalize(e)
  },
  "mailto:": {
    validate: function(e, n, t) {
      let o = t.re.get_mailto_validator();
      o.lastIndex = n;
      let r = o.exec(e);
      return r ? r[0].length : 0;
    },
    normalize: (e, n) => n.normalize(e)
  }
}, ko = "a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw", Co = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444";
function Ro() {
  let e = Co.split("|");
  return ko.split("|").forEach((n) => {
    let t = n.indexOf(":"), o = n.slice(0, t);
    for (let r of n.slice(t + 1)) e.push(o + r);
  }), e;
}
var _o = {
  fuzzyLink: !1,
  fuzzyEmail: !0,
  fuzzyIP: !1,
  "---": !1,
  tlds: Ro(),
  urlAuth: !1,
  maxLength: 1e4
}, st = class {
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
  constructor(e, n, t, o) {
    let r = e.slice(t, o);
    this.schema = n.toLowerCase(), this.index = t, this.lastIndex = o, this.raw = r, this.text = r, this.url = r;
  }
}, at = class {
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
    let { rebuilder: n, ...t } = e;
    this.__opts__ = {
      ..._o,
      ...t
    }, this.__schemas__ = { ...wo }, this.re = n || new xo(), this.re.set({
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
  add(e, n = null) {
    if (!n) delete this.__schemas__[e];
    else {
      let t = {
        normalize: (o, r) => r.normalize(o),
        ...n
      };
      this.__schemas__[e] = t;
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
    let n, t;
    for (t = this.re.get_schema_search(), t.lastIndex = 0; (n = t.exec(e)) !== null; ) if (this.testSchemaAt(e, n[2], t.lastIndex)) return !0;
    if (this.__opts__.fuzzyLink && this.__schemas__["http:"] && (t = this.re.get_fuzzy_link_search(), t.lastIndex = 0, t.exec(e) !== null))
      return !0;
    if (this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && e.indexOf("@") >= 0) {
      let o = this.re.get_fuzzy_mail_host_search(), r = this.re.get_mail_name_validator();
      for (o.lastIndex = 0; (n = o.exec(e)) !== null; ) {
        let i = e.slice(Math.max(0, n.index - 65), n.index);
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
  testSchemaAt(e, n, t) {
    return this.__schemas__[n.toLowerCase()] ? this.__schemas__[n.toLowerCase()].validate(e.slice(0, t + this.__opts__.maxLength), t, this) : 0;
  }
  /**
  * Returns array of found link descriptions or `null` on fail. We strongly
  * recommend to use {@link LinkifyIt.test} first, for best speed.
  *
  * @param text Text to scan.
  */
  match(e) {
    let n = [], t = this.re.get_schema_search(), o, r, i, s, a, l, d = !1, h = !1, f = !1, y = 0;
    if (!e.length) return null;
    for (t.lastIndex = 0, this.__opts__.fuzzyLink && this.__schemas__["http:"] && (o = this.re.get_fuzzy_link_search(), o.lastIndex = 0), this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && (r = this.re.get_fuzzy_mail_host_search(), r.lastIndex = 0, i = this.re.get_mail_name_validator()); ; ) {
      let u = Math.max(y - 1, 0);
      if (r && i && !f && (!a || a.index < y))
        for (r.lastIndex < u && (r.lastIndex = u); ; ) {
          let g = r.exec(e);
          if (!g) {
            f = !0, a = void 0;
            break;
          }
          let x = i.exec(e.slice(Math.max(0, g.index - 65), g.index));
          if (x) {
            if (a = {
              schema: "mailto:",
              index: g.index - x[1].length,
              lastIndex: g.index + g[0].length
            }, a.index >= y) break;
            r.lastIndex < u && (r.lastIndex = u);
          }
        }
      if (o && !h && (!s || s.index < y))
        for (o.lastIndex < u && (o.lastIndex = u); ; ) {
          let g = o.exec(e);
          if (!g) {
            h = !0, s = void 0;
            break;
          }
          if (s = {
            schema: "",
            index: g.index + g[1].length,
            lastIndex: g.index + g[0].length
          }, s.index >= y) break;
          o.lastIndex < u && (o.lastIndex = u);
        }
      let c = a;
      (!c || s && (s.index < c.index || s.index === c.index && s.lastIndex > c.lastIndex)) && (c = s);
      let m;
      if (!d) for (; ; ) {
        if (!l) {
          t.lastIndex < u && (t.lastIndex = u);
          let w = t.exec(e);
          if (!w) {
            d = !0;
            break;
          }
          l = {
            schema: w[2],
            index: w.index + w[1].length,
            lastIndex: w.index + w[0].length
          };
        }
        if (l.index < y) {
          l = void 0;
          continue;
        }
        if (c && l.index > c.index) break;
        let g = l;
        l = void 0;
        let x = this.testSchemaAt(e, g.schema, g.lastIndex);
        if (x) {
          m = {
            schema: g.schema,
            index: g.index,
            lastIndex: g.lastIndex + x
          };
          break;
        }
      }
      let p = m;
      if ((!p || a && (a.index < p.index || a.index === p.index && a.lastIndex > p.lastIndex)) && (p = a), (!p || s && (s.index < p.index || s.index === p.index && s.lastIndex > p.lastIndex)) && (p = s), !p) break;
      p === a ? a = void 0 : p === s && (s = void 0);
      let b = new st(e, p.schema, p.index, p.lastIndex);
      b.schema ? this.__schemas__[b.schema].normalize(b, this) : this.normalize(b), n.push(b), y = p.lastIndex;
    }
    return n.length ? n : null;
  }
  /**
  * Returns fully-formed (not fuzzy) link if it starts at the beginning
  * of the string, and null otherwise.
  *
  * @param text Text to scan.
  */
  matchAtStart(e) {
    if (!e.length) return null;
    let n = this.re.get_schema_at_start().exec(e);
    if (!n) return null;
    let t = this.testSchemaAt(e, n[2], n[0].length);
    if (!t) return null;
    let o = new st(e, n[2], n.index + n[1].length, n.index + n[0].length + t);
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
  tlds(e, n = !1) {
    return e = Array.isArray(e) ? e : [e], n ? this.__opts__.tlds = this.__opts__.tlds.concat(e) : this.__opts__.tlds = e, this.re.set({
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

// openclaw/node_modules/.pnpm/markdown-it@15.0.3/node_modules/markdown-it/dist/markdown-it.mjs
var un = hn(ht(), 1);
var mt = Object.defineProperty, At = (e, n) => {
  let t = {};
  for (var o in e) mt(t, o, {
    get: e[o],
    enumerable: !0
  });
  return n || mt(t, Symbol.toStringTag, { value: "Module" }), t;
}, Fo = /* @__PURE__ */ At({
  arrayReplaceAt: () => No,
  asciiTrim: () => De,
  callable: () => Et,
  escapeHtml: () => H,
  escapeRE: () => Jo,
  fromCodePoint: () => ge,
  isMdAsciiPunct: () => ye,
  isPunctChar: () => Mt,
  isPunctCharCode: () => me,
  isSpace: () => E,
  isValidEntityCode: () => cn,
  isWhiteSpace: () => he,
  lib: () => Ko,
  normalizeReference: () => Me,
  unescapeAll: () => ie,
  unescapeMd: () => jo
});
function Et(e) {
  let n = function(...t) {
    return Reflect.construct(e, t, new.target && new.target !== n ? new.target : e);
  };
  return Object.defineProperty(n, "name", { value: e.name }), Object.setPrototypeOf(n, e), n.prototype = e.prototype, n;
}
function No(e, n, t) {
  return [].concat(e.slice(0, n), t, e.slice(n + 1));
}
function cn(e) {
  return !(e >= 55296 && e <= 57343 || e >= 64976 && e <= 65007 || (e & 65535) === 65535 || (e & 65535) === 65534 || e >= 0 && e <= 8 || e === 11 || e >= 14 && e <= 31 || e >= 127 && e <= 159 || e > 1114111);
}
function ge(e) {
  if (e > 65535) {
    e -= 65536;
    let n = 55296 + (e >> 10), t = 56320 + (e & 1023);
    return String.fromCharCode(n, t);
  }
  return String.fromCharCode(e);
}
var vt = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, Lo = new RegExp(`${vt.source}|${/&([a-z#][a-z0-9]{1,31});/gi.source}`, "gi"), Bo = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function Uo(e, n) {
  if (n.charCodeAt(0) === 35 && Bo.test(n)) {
    let o = n[1].toLowerCase() === "x" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    return cn(o) ? ge(o) : e;
  }
  let t = Se(e);
  return t !== e ? t : e;
}
function jo(e) {
  return e.indexOf("\\") < 0 ? e : e.replace(vt, "$1");
}
function ie(e) {
  return e.indexOf("\\") < 0 && e.indexOf("&") < 0 ? e : e.replace(Lo, function(n, t, o) {
    return t || Uo(n, o);
  });
}
var zo = /[&<>"]/, $o = /[&<>"]/g, Wo = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function qo(e) {
  return Wo[e];
}
function H(e) {
  return zo.test(e) ? e.replace($o, qo) : e;
}
var Go = /[.?*+^$[\]\\(){}|-]/g;
function Jo(e) {
  return e.replace(Go, "\\$&");
}
function E(e) {
  switch (e) {
    case 9:
    case 32:
      return !0;
  }
  return !1;
}
function he(e) {
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
function Mt(e) {
  return pe.test(e) || He.test(e);
}
function me(e) {
  return Mt(ge(e));
}
function ye(e) {
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
function Me(e) {
  return e = e.trim().replace(/\s+/g, " "), e.toLowerCase().toUpperCase();
}
function yt(e) {
  return e === 32 || e === 9 || e === 10 || e === 13;
}
function De(e) {
  let n = 0;
  for (; n < e.length && yt(e.charCodeAt(n)); n++) ;
  let t = e.length - 1;
  for (; t >= n && yt(e.charCodeAt(t)); t--) ;
  return e.slice(n, t + 1);
}
var Ko = {
  mdurl: Ge,
  ucmicro: Ve
};
function Ho(e, n, t) {
  let o, r, i, s, a = e.posMax, l = e.pos;
  for (e.pos = n + 1, o = 1; e.pos < a; ) {
    if (i = e.src.charCodeAt(e.pos), i === 93 && (o--, o === 0)) {
      r = !0;
      break;
    }
    if (s = e.pos, e.md.inline.skipToken(e), i === 91) {
      if (s === e.pos - 1) o++;
      else if (t)
        return e.pos = l, -1;
    }
  }
  let d = -1;
  return r && (d = e.pos), e.pos = l, d;
}
function Xo(e, n, t) {
  let o, r = n, i = {
    ok: !1,
    pos: 0,
    str: ""
  };
  if (e.charCodeAt(r) === 60) {
    for (r++; r < t; ) {
      if (o = e.charCodeAt(r), o === 10 || o === 60) return i;
      if (o === 62)
        return i.pos = r + 1, i.str = ie(e.slice(n + 1, r)), i.ok = !0, i;
      if (o === 92 && r + 1 < t) {
        r += 2;
        continue;
      }
      r++;
    }
    return i;
  }
  let s = 0;
  for (; r < t && (o = e.charCodeAt(r), !(o === 32 || o < 32 || o === 127)); ) {
    if (o === 92 && r + 1 < t) {
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
  return n === r || s !== 0 || (i.str = ie(e.slice(n, r)), i.pos = r, i.ok = !0), i;
}
function Vo(e, n, t, o) {
  let r, i = n, s = {
    ok: !1,
    can_continue: !1,
    pos: 0,
    str: "",
    marker: 0
  };
  if (o)
    s.str = o.str, s.marker = o.marker;
  else {
    if (i >= t) return s;
    let a = e.charCodeAt(i);
    if (a !== 34 && a !== 39 && a !== 40) return s;
    n++, i++, a === 40 && (a = 41), s.marker = a;
  }
  for (; i < t; ) {
    if (r = e.charCodeAt(i), r === s.marker)
      return s.pos = i + 1, s.str += ie(e.slice(n, i)), s.ok = !0, s;
    if (r === 40 && s.marker === 41) return s;
    r === 92 && i + 1 < t && i++, i++;
  }
  return s.can_continue = !0, s.str += ie(e.slice(n, i)), s;
}
var Yo = /* @__PURE__ */ At({
  parseLinkDestination: () => Xo,
  parseLinkLabel: () => Ho,
  parseLinkTitle: () => Vo
});
function be(e) {
  "@babel/helpers - typeof";
  return be = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(n) {
    return typeof n;
  } : function(n) {
    return n && typeof Symbol == "function" && n.constructor === Symbol && n !== Symbol.prototype ? "symbol" : typeof n;
  }, be(e);
}
function Zo(e, n) {
  if (be(e) != "object" || !e) return e;
  var t = e[Symbol.toPrimitive];
  if (t !== void 0) {
    var o = t.call(e, n || "default");
    if (be(o) != "object") return o;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (n === "string" ? String : Number)(e);
}
function Qo(e) {
  var n = Zo(e, "string");
  return be(n) == "symbol" ? n : n + "";
}
function R(e, n, t) {
  return (n = Qo(n)) in e ? Object.defineProperty(e, n, {
    value: t,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[n] = t, e;
}
var ee = class {
  constructor(e, n, t) {
    R(
      this,
      /**
      * Source map info. Format: `[ line_begin, line_end ]`
      */
      "map",
      null
    ), R(
      this,
      /**
      * nesting level, the same as `state.level`
      */
      "level",
      0
    ), R(
      this,
      /**
      * An array of child nodes (inline and img tokens)
      */
      "children",
      null
    ), R(
      this,
      /**
      * In a case of self-closing tag (code, html, fence, etc.),
      * it has contents of this tag.
      */
      "content",
      ""
    ), R(
      this,
      /**
      * '*' or '_' for emphasis, fence string for fence, etc.
      */
      "markup",
      ""
    ), R(
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
    ), R(
      this,
      /**
      * True for block-level tokens, false for inline tokens.
      * Used in renderer to calculate line breaks
      */
      "block",
      !1
    ), R(
      this,
      /**
      * If it's true, ignore this element when rendering. Used for tight lists
      * to hide paragraphs.
      */
      "hidden",
      !1
    ), this.type = e, this.tag = n, this.attrs = null, this.nesting = t, this.meta = null;
  }
  /**
  * Search attribute index by name.
  */
  attrIndex(e) {
    if (!this.attrs) return -1;
    let n = this.attrs;
    for (let t = 0, o = n.length; t < o; t++) if (n[t][0] === e) return t;
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
  attrSet(e, n) {
    let t = this.attrIndex(e), o = [e, n];
    t < 0 ? this.attrPush(o) : this.attrs[t] = o;
  }
  /**
  * Get the value of attribute `name`, or null if it does not exist.
  */
  attrGet(e) {
    let n = this.attrIndex(e), t = null;
    return n >= 0 && (t = this.attrs[n][1]), t;
  }
  /**
  * Join value to existing attribute via space. Or create new attribute if not
  * exists. Useful to operate with token classes.
  */
  attrJoin(e, n) {
    let t = this.attrIndex(e);
    t < 0 ? this.attrPush([e, n]) : this.attrs[t][1] = `${this.attrs[t][1]} ${n}`;
  }
}, xe = class {
  constructor() {
    R(
      this,
      /** @internal */
      "__rules__",
      []
    ), R(
      this,
      /** @internal */
      "__cache__",
      null
    );
  }
  /** @internal */
  __find__(e) {
    for (let n = 0; n < this.__rules__.length; n++) if (this.__rules__[n].name === e) return n;
    return -1;
  }
  /** @internal */
  __compile__() {
    let e = /* @__PURE__ */ new Set();
    this.__rules__.forEach((n) => {
      n.enabled && n.alt.forEach((t) => {
        t && e.add(t);
      });
    }), this.__cache__ = /* @__PURE__ */ Object.create(null), this.__cache__[""] = [], this.__rules__.forEach((n) => {
      n.enabled && this.__cache__[""].push(n.fn);
    }), e.forEach((n) => {
      this.__cache__[n] = [], this.__rules__.forEach((t) => {
        t.enabled && t.alt.indexOf(n) >= 0 && this.__cache__[n].push(t.fn);
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
  at(e, n, t = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__[o].fn = n, this.__rules__[o].alt = t.alt || [], this.__cache__ = null;
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
  before(e, n, t, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r, 0, {
      name: n,
      enabled: !0,
      fn: t,
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
  after(e, n, t, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r + 1, 0, {
      name: n,
      enabled: !0,
      fn: t,
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
  push(e, n, t = {}) {
    this.__rules__.push({
      name: e,
      enabled: !0,
      fn: n,
      alt: t.alt || []
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
  enable(e, n = !1) {
    Array.isArray(e) || (e = [e]);
    let t = [];
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (n) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !0, t.push(o);
    }), this.__cache__ = null, t;
  }
  /**
  * Enable rules with given names, and disable everything else. If any rule name
  * not found - throw Error. Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enable}.
  */
  enableOnly(e, n = !1) {
    Array.isArray(e) || (e = [e]), this.__rules__.forEach((t) => {
      t.enabled = !1;
    }), this.enable(e, n);
  }
  /**
  * Disable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.enable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  disable(e, n = !1) {
    Array.isArray(e) || (e = [e]);
    let t = [];
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (n) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !1, t.push(o);
    }), this.__cache__ = null, t;
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
}, q = {};
q.code_inline = function(e, n, t, o, r) {
  let i = e[n];
  return `<code${r.renderAttrs(i)}>${H(i.content)}</code>`;
};
q.code_block = function(e, n, t, o, r) {
  let i = e[n];
  return `<pre${r.renderAttrs(i)}><code>${H(e[n].content)}</code></pre>
`;
};
q.fence = function(e, n, t, o, r) {
  let i = e[n], s = i.info ? ie(i.info).trim() : "", a = "", l = "";
  if (s) {
    let h = s.split(/(\s+)/g);
    a = h[0], l = h.slice(2).join("");
  }
  let d;
  if (t.highlight ? d = t.highlight(i.content, a, l) || H(i.content) : d = H(i.content), d.indexOf("<pre") === 0) return d + `
`;
  if (s) {
    let h = i.attrIndex("class"), f = i.attrs ? i.attrs.slice() : [];
    h < 0 ? f.push(["class", `${t.langPrefix}${a}`]) : (f[h] = [f[h][0], f[h][1]], f[h][1] += ` ${t.langPrefix}${a}`);
    let y = { attrs: f };
    return `<pre><code${r.renderAttrs(y)}>${d}</code></pre>
`;
  }
  return `<pre><code${r.renderAttrs(i)}>${d}</code></pre>
`;
};
q.image = function(e, n, t, o, r) {
  let i = e[n];
  return i.attrs[i.attrIndex("alt")][1] = r.renderInlineAsText(i.children, t, o), r.renderToken(e, n, t);
};
q.hardbreak = function(e, n, t) {
  return t.xhtmlOut ? `<br />
` : `<br>
`;
};
q.softbreak = function(e, n, t) {
  return t.breaks ? t.xhtmlOut ? `<br />
` : `<br>
` : `
`;
};
q.text = function(e, n) {
  return H(e[n].content);
};
q.html_block = function(e, n) {
  return e[n].content;
};
q.html_inline = function(e, n) {
  return e[n].content;
};
var Dt = class {
  constructor() {
    R(
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
      Object.assign({}, q)
    );
  }
  /**
  * Render token attributes to string.
  */
  renderAttrs(e) {
    let n, t, o;
    if (!e.attrs) return "";
    for (o = "", n = 0, t = e.attrs.length; n < t; n++) o += ` ${H(e.attrs[n][0])}="${H(String(e.attrs[n][1]))}"`;
    return o;
  }
  /**
  * Default token renderer. Can be overriden by custom function
  * in {@link Renderer.rules}.
  */
  renderToken(e, n, t) {
    let o = e[n], r = "";
    if (o.hidden) return "";
    let i = n - 1;
    for (; i >= 0 && e[i].hidden && e[i].nesting === 0; ) i--;
    o.block && o.nesting !== -1 && i >= 0 && e[i].hidden && e[i].nesting === -1 && (r += `
`), r += (o.nesting === -1 ? "</" : "<") + o.tag, r += this.renderAttrs(o), o.nesting === 0 && t.xhtmlOut && (r += " /");
    let s = !1;
    if (o.block && (s = !0, o.nesting === 1)) {
      let a = n + 1;
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
  renderInline(e, n, t) {
    let o = "", r = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      typeof r[a] < "u" ? o += r[a](e, i, n, t, this) : o += this.renderToken(e, i, n);
    }
    return o;
  }
  /**
  * Special kludge for image `alt` attributes to conform CommonMark spec.
  * Don't try to use it! Spec requires to show `alt` content with stripped markup,
  * instead of simple escaping.
  */
  renderInlineAsText(e, n, t) {
    let o = "";
    for (let r = 0, i = e.length; r < i; r++) switch (e[r].type) {
      case "text":
      case "code_inline":
        o += e[r].content;
        break;
      case "image":
        o += this.renderInlineAsText(e[r].children, n, t);
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
  render(e, n, t) {
    let o = "", r = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      a === "inline" ? o += this.renderInline(e[i].children, n, t) : typeof r[a] < "u" ? o += r[a](e, i, n, t, this) : o += this.renderToken(e, i, n);
    }
    return o;
  }
}, Pt = class {
  constructor(e, n, t) {
    R(this, "tokens", []), R(this, "inlineMode", !1), R(this, "Token", ee), this.src = e, this.env = t, this.md = n;
  }
}, ei = /\r\n?/g, ni = /\0/g;
function ti(e) {
  let n;
  n = e.src.replace(ei, `
`), n = n.replace(ni, "\uFFFD"), e.src = n;
}
function ri(e) {
  let n;
  e.inlineMode ? (n = new e.Token("inline", "", 0), n.content = e.src, n.map = [0, 1], n.children = [], e.tokens.push(n)) : e.md.block.parse(e.src, e.md, e.env, e.tokens);
}
function oi(e) {
  let n = e.tokens, t = 0;
  for (let o = 0; o < n.length; o++)
    n[o].type !== "reference_definition" && (o !== t && (n[t] = n[o]), t++);
  n.length !== t && (n.length = t);
}
function ii(e) {
  let n = e.tokens;
  for (let t = 0, o = n.length; t < o; t++) {
    let r = n[t];
    r.type === "inline" && e.md.inline.parse(r.content, e.md, e.env, r.children);
  }
}
function si(e) {
  return /^<a[>\s]/i.test(e);
}
function ai(e) {
  return /^<\/a\s*>/i.test(e);
}
function ui(e) {
  let n = e.tokens;
  if (e.md.options.linkify)
    for (let t = 0, o = n.length; t < o; t++) {
      if (n[t].type !== "inline" || !e.md.linkify.test(n[t].content)) continue;
      let r = n[t].children, i = [], s = 0;
      for (let a = r.length - 1; a >= 0; a--) {
        let l = r[a];
        if (l.type === "link_close") {
          for (a--; r[a].level !== l.level && r[a].type !== "link_open"; ) a--;
          continue;
        }
        if (l.type === "html_inline" && (si(l.content) && s > 0 && s--, ai(l.content) && s++), !(s > 0) && l.type === "text" && e.md.linkify.test(l.content)) {
          let d = l.content, h = e.md.linkify.match(d), f = [], y = l.level, u = 0;
          h.length > 0 && h[0].index === 0 && a > 0 && r[a - 1].type === "text_special" && (h = h.slice(1));
          for (let c = 0; c < h.length; c++) {
            let m = h[c].url, p = e.md.normalizeLink(m);
            if (!e.md.validateLink(p)) continue;
            let b = h[c].text;
            h[c].schema ? h[c].schema === "mailto:" && !/^mailto:/i.test(b) ? b = e.md.normalizeLinkText(`mailto:${b}`).replace(/^mailto:/, "") : b = e.md.normalizeLinkText(b) : b = e.md.normalizeLinkText(`http://${b}`).replace(/^http:\/\//, "");
            let g = h[c].index;
            if (g > u) {
              let C = new e.Token("text", "", 0);
              C.content = d.slice(u, g), C.level = y, f.push(C);
            }
            let x = new e.Token("link_open", "a", 1);
            x.attrs = [["href", p]], x.level = y++, x.markup = "linkify", x.info = "auto", f.push(x);
            let w = new e.Token("text", "", 0);
            w.content = b, w.level = y, f.push(w);
            let k = new e.Token("link_close", "a", -1);
            k.level = --y, k.markup = "linkify", k.info = "auto", f.push(k), u = h[c].lastIndex;
          }
          if (u < d.length) {
            let c = new e.Token("text", "", 0);
            c.content = d.slice(u), c.level = y, f.push(c);
          }
          i.push({
            index: a,
            nodes: f
          });
        }
      }
      if (i.length > 0) {
        let a = r.length;
        for (let f of i) a += f.nodes.length - 1;
        let l = new Array(a), d = 0, h = 0;
        i.reverse();
        for (let f = 0; f < r.length; f++) {
          let y = i[d];
          if (y?.index === f) {
            for (let u of y.nodes) l[h++] = u;
            d++;
          } else l[h++] = r[f];
        }
        n[t].children = l;
      }
    }
}
var Ot = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/, ci = /\((c|tm|r)\)/i, li = /\((c|tm|r)\)/gi, di = {
  c: "\xA9",
  r: "\xAE",
  tm: "\u2122"
};
function pi(e, n) {
  return di[n.toLowerCase()];
}
function fi(e) {
  let n = 0;
  for (let t = e.length - 1; t >= 0; t--) {
    let o = e[t];
    o.type === "text" && !n && (o.content = o.content.replace(li, pi)), o.type === "link_open" && o.info === "auto" && n--, o.type === "link_close" && o.info === "auto" && n++;
  }
}
function gi(e) {
  let n = 0;
  for (let t = e.length - 1; t >= 0; t--) {
    let o = e[t];
    o.type === "text" && !n && Ot.test(o.content) && (o.content = o.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013")), o.type === "link_open" && o.info === "auto" && n--, o.type === "link_close" && o.info === "auto" && n++;
  }
}
function hi(e) {
  let n;
  if (e.md.options.typographer)
    for (n = e.tokens.length - 1; n >= 0; n--)
      e.tokens[n].type === "inline" && (ci.test(e.tokens[n].content) && fi(e.tokens[n].children), Ot.test(e.tokens[n].content) && gi(e.tokens[n].children));
}
var mi = /['"]/, bt = /['"]/g, xt = "\u2019", yi = 1e3;
function wt(e, n, t) {
  for (; e.length > t; ) {
    let o = e.pop();
    o.isSingleQuote ? n.single = o.prevSameQuoteIdx : n.double = o.prevSameQuoteIdx;
  }
}
function Ae(e, n, t, o) {
  e[n] || (e[n] = []), e[n].push({
    pos: t,
    ch: o
  });
}
function bi(e, n) {
  let t = "", o = 0;
  n.sort((r, i) => r.pos - i.pos);
  for (let r = 0; r < n.length; r++) {
    let i = n[r];
    t += e.slice(o, i.pos) + i.ch, o = i.pos + 1;
  }
  return t + e.slice(o);
}
function xi(e, n) {
  let t, o = [], r = {
    single: -1,
    double: -1
  }, i = {};
  for (let s = 0; s < e.length; s++) {
    let a = e[s], l = e[s].level;
    for (t = o.length - 1; t >= 0 && !(o[t].level <= l); t--) ;
    if (wt(o, r, t + 1), a.type !== "text") continue;
    let d = a.content, h = 0, f = d.length;
    e: for (; h < f; ) {
      bt.lastIndex = h;
      let y = bt.exec(d);
      if (!y) break;
      let u = !0, c = !0;
      h = y.index + 1;
      let m = y[0] === "'", p = 32;
      if (y.index - 1 >= 0) p = d.charCodeAt(y.index - 1);
      else for (t = s - 1; t >= 0 && !(e[t].type === "softbreak" || e[t].type === "hardbreak"); t--)
        if (e[t].content) {
          p = e[t].content.charCodeAt(e[t].content.length - 1);
          break;
        }
      let b = 32;
      if (h < f) b = d.charCodeAt(h);
      else for (t = s + 1; t < e.length && !(e[t].type === "softbreak" || e[t].type === "hardbreak"); t++)
        if (e[t].content) {
          b = e[t].content.charCodeAt(0);
          break;
        }
      let g = ye(p) || me(p), x = ye(b) || me(b), w = he(p), k = he(b);
      if (k ? u = !1 : x && (w || g || (u = !1)), w ? c = !1 : g && (k || x || (c = !1)), b === 34 && y[0] === '"' && p >= 48 && p <= 57 && (c = u = !1), u && c && (u = g, c = x), !u && !c) {
        m && Ae(i, s, y.index, xt);
        continue;
      }
      if (c && (t = m ? r.single : r.double, t >= 0 && o[t].level === l)) {
        let C = o[t], _, A;
        m ? (_ = n.md.options.quotes[2], A = n.md.options.quotes[3]) : (_ = n.md.options.quotes[0], A = n.md.options.quotes[1]), Ae(i, s, y.index, A), Ae(i, C.tokenIdx, C.contentPos, _), wt(o, r, t);
        continue e;
      }
      if (u) {
        if (o.length >= yi) return;
        o.push({
          tokenIdx: s,
          contentPos: y.index,
          isSingleQuote: m,
          level: l,
          prevSameQuoteIdx: m ? r.single : r.double
        }), m ? r.single = o.length - 1 : r.double = o.length - 1;
      } else c && m && Ae(i, s, y.index, xt);
    }
  }
  Object.keys(i).forEach(function(s) {
    let a = Number(s);
    e[a].content = bi(e[a].content, i[s]);
  });
}
function wi(e) {
  if (e.md.options.typographer)
    for (let n = e.tokens.length - 1; n >= 0; n--)
      e.tokens[n].type !== "inline" || !mi.test(e.tokens[n].content) || xi(e.tokens[n].children, e);
}
function ki(e) {
  let n, t, o = e.length;
  for (n = 0; n < o; n++) e[n].type === "text_special" && (e[n].type = "text");
  for (n = t = 0; n < o; n++) e[n].type === "text" && n + 1 < o && e[n + 1].type === "text" ? e[n + 1].content = e[n].content + e[n + 1].content : (n !== t && (e[t] = e[n]), t++);
  n !== t && (e.length = t);
}
function Ci(e) {
  let n, t, o = e.tokens, r = o.length;
  for (let i = 0; i < r; i++) {
    if (o[i].type !== "inline") continue;
    let s = o[i].children, a = s.length;
    for (n = 0; n < a; n++)
      s[n].type === "text_special" && (s[n].type = "text"), s[n].children && ki(s[n].children);
    for (n = t = 0; n < a; n++) s[n].type === "text" && n + 1 < a && s[n + 1].type === "text" ? s[n + 1].content = s[n].content + s[n + 1].content : (n !== t && (s[t] = s[n]), t++);
    n !== t && (s.length = t);
  }
}
var tn = [
  ["normalize", ti],
  ["block", ri],
  ["strip_references", oi],
  ["inline", ii],
  ["linkify", ui],
  ["replacements", hi],
  ["smartquotes", wi],
  ["text_join", Ci]
], Ft = class {
  constructor() {
    R(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of core rules.
      */
      "ruler",
      new xe()
    ), R(this, "State", Pt);
    for (let e = 0; e < tn.length; e++) this.ruler.push(tn[e][0], tn[e][1]);
  }
  /**
  * Executes core chain rules.
  */
  process(e) {
    let n = this.ruler.getRules("");
    for (let t = 0, o = n.length; t < o; t++) n[t](e);
  }
}, Nt = class {
  constructor(e, n, t, o) {
    R(this, "bMarks", []), R(this, "eMarks", []), R(this, "tShift", []), R(this, "sCount", []), R(this, "bsCount", []), R(this, "blkIndent", 0), R(this, "line", 0), R(this, "lineMax", 0), R(this, "tight", !1), R(this, "listIndent", -1), R(this, "parentType", "root"), R(this, "level", 0), R(this, "Token", ee), this.src = e, this.md = n, this.env = t, this.tokens = o;
    let r = this.src;
    for (let i = 0, s = 0, a = 0, l = 0, d = r.length, h = !1; s < d; s++) {
      let f = r.charCodeAt(s);
      if (!h)
        if (E(f)) {
          a++, f === 9 ? l += 4 - l % 4 : l++;
          continue;
        } else h = !0;
      (f === 10 || s === d - 1) && (f !== 10 && s++, this.bMarks.push(i), this.eMarks.push(s), this.tShift.push(a), this.sCount.push(l), this.bsCount.push(0), h = !1, a = 0, l = 0, i = s + 1);
    }
    this.bMarks.push(r.length), this.eMarks.push(r.length), this.tShift.push(0), this.sCount.push(0), this.bsCount.push(0), this.lineMax = this.bMarks.length - 1;
  }
  push(e, n, t) {
    let o = new ee(e, n, t);
    return o.block = !0, t < 0 && this.level--, o.level = this.level, t > 0 && this.level++, this.tokens.push(o), o;
  }
  isEmpty(e) {
    return this.bMarks[e] + this.tShift[e] >= this.eMarks[e];
  }
  skipEmptyLines(e) {
    for (let n = this.lineMax; e < n && !(this.bMarks[e] + this.tShift[e] < this.eMarks[e]); e++) ;
    return e;
  }
  skipSpaces(e) {
    for (let n = this.src.length; e < n && E(this.src.charCodeAt(e)); e++) ;
    return e;
  }
  skipSpacesBack(e, n) {
    if (e <= n) return e;
    for (; e > n; ) if (!E(this.src.charCodeAt(--e))) return e + 1;
    return e;
  }
  skipChars(e, n) {
    for (let t = this.src.length; e < t && this.src.charCodeAt(e) === n; e++) ;
    return e;
  }
  skipCharsBack(e, n, t) {
    if (e <= t) return e;
    for (; e > t; ) if (n !== this.src.charCodeAt(--e)) return e + 1;
    return e;
  }
  getLines(e, n, t, o) {
    if (e >= n) return "";
    let r = new Array(n - e);
    for (let i = 0, s = e; s < n; s++, i++) {
      let a = 0, l = this.bMarks[s], d = l, h;
      for (s + 1 < n || o ? h = this.eMarks[s] + 1 : h = this.eMarks[s]; d < h && a < t; ) {
        let f = this.src.charCodeAt(d);
        if (E(f))
          f === 9 ? a += 4 - (a + this.bsCount[s]) % 4 : a++;
        else if (d - l < this.tShift[s]) a++;
        else break;
        d++;
      }
      a > t ? r[i] = new Array(a - t + 1).join(" ") + this.src.slice(d, h) : r[i] = this.src.slice(d, h);
    }
    return r.join("");
  }
}, Ri = 65536;
function rn(e, n) {
  let t = e.bMarks[n] + e.tShift[n], o = e.eMarks[n];
  return e.src.slice(t, o);
}
function kt(e) {
  let n = [], t = e.length, o = 0, r = e.charCodeAt(o), i = !1, s = 0, a = "";
  for (; o < t; )
    r === 124 && (i ? (a += e.substring(s, o - 1), s = o) : (n.push(a + e.substring(s, o)), a = "", s = o + 1)), i = r === 92, o++, r = e.charCodeAt(o);
  return n.push(a + e.substring(s)), n;
}
function _i(e, n, t, o) {
  if (n + 2 > t) return !1;
  let r = n + 1;
  if (e.sCount[r] < e.blkIndent || e.sCount[r] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[r] + e.tShift[r];
  if (i >= e.eMarks[r]) return !1;
  let s = e.src.charCodeAt(i++);
  if (s !== 124 && s !== 45 && s !== 58 || i >= e.eMarks[r]) return !1;
  let a = e.src.charCodeAt(i++);
  if (a !== 124 && a !== 45 && a !== 58 && !E(a) || s === 45 && E(a)) return !1;
  for (; i < e.eMarks[r]; ) {
    let w = e.src.charCodeAt(i);
    if (w !== 124 && w !== 45 && w !== 58 && !E(w)) return !1;
    i++;
  }
  let l = rn(e, n + 1), d = l.split("|"), h = [];
  for (let w = 0; w < d.length; w++) {
    let k = d[w].trim();
    if (!k) {
      if (w === 0 || w === d.length - 1) continue;
      return !1;
    }
    if (!/^:?-+:?$/.test(k)) return !1;
    k.charCodeAt(k.length - 1) === 58 ? h.push(k.charCodeAt(0) === 58 ? "center" : "right") : k.charCodeAt(0) === 58 ? h.push("left") : h.push("");
  }
  if (l = rn(e, n).trim(), l.indexOf("|") === -1 || e.sCount[n] - e.blkIndent >= 4) return !1;
  d = kt(l), d.length && d[0] === "" && d.shift(), d.length && d[d.length - 1] === "" && d.pop();
  let f = d.length;
  if (f === 0 || f !== h.length) return !1;
  if (o) return !0;
  let y = e.parentType;
  e.parentType = "table";
  let u = e.md.block.ruler.getRules("blockquote"), c = e.push("table_open", "table", 1), m = [n, 0];
  c.map = m;
  let p = e.push("thead_open", "thead", 1);
  p.map = [n, n + 1];
  let b = e.push("tr_open", "tr", 1);
  b.map = [n, n + 1];
  for (let w = 0; w < d.length; w++) {
    let k = e.push("th_open", "th", 1);
    h[w] && (k.attrs = [["style", `text-align:${h[w]}`]]);
    let C = e.push("inline", "", 0);
    C.content = d[w].trim(), C.children = [], e.push("th_close", "th", -1);
  }
  e.push("tr_close", "tr", -1), e.push("thead_close", "thead", -1);
  let g, x = 0;
  for (r = n + 2; r < t && !(e.sCount[r] < e.blkIndent); r++) {
    let w = !1;
    for (let C = 0, _ = u.length; C < _; C++) if (u[C](e, r, t, !0)) {
      w = !0;
      break;
    }
    if (w || (l = rn(e, r).trim(), !l) || e.sCount[r] - e.blkIndent >= 4 || (d = kt(l), d.length && d[0] === "" && d.shift(), d.length && d[d.length - 1] === "" && d.pop(), x += f - d.length, x > Ri)) break;
    if (r === n + 2) {
      let C = e.push("tbody_open", "tbody", 1);
      C.map = g = [n + 2, 0];
    }
    let k = e.push("tr_open", "tr", 1);
    k.map = [r, r + 1];
    for (let C = 0; C < f; C++) {
      let _ = e.push("td_open", "td", 1);
      h[C] && (_.attrs = [["style", `text-align:${h[C]}`]]);
      let A = e.push("inline", "", 0);
      A.content = d[C] ? d[C].trim() : "", A.children = [], e.push("td_close", "td", -1);
    }
    e.push("tr_close", "tr", -1);
  }
  return g && (e.push("tbody_close", "tbody", -1), g[1] = r), e.push("table_close", "table", -1), m[1] = r, e.parentType = y, e.line = r, !0;
}
function Ti(e, n, t) {
  if (e.sCount[n] - e.blkIndent < 4) return !1;
  let o = n + 1, r = o;
  for (; o < t; ) {
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
  return i.content = e.getLines(n, r, 4 + e.blkIndent, !1) + `
`, i.map = [n, e.line], !0;
}
function Ii(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4 || r + 3 > i) return !1;
  let s = e.src.charCodeAt(r);
  if (s !== 126 && s !== 96) return !1;
  let a = r;
  r = e.skipChars(r, s);
  let l = r - a;
  if (l < 3) return !1;
  let d = e.src.slice(a, r), h = e.src.slice(r, i);
  if (s === 96 && h.indexOf(String.fromCharCode(s)) >= 0)
    return !1;
  if (o) return !0;
  let f = n, y = !1;
  for (; f++, !(f >= t || (r = a = e.bMarks[f] + e.tShift[f], i = e.eMarks[f], r < i && e.sCount[f] < e.blkIndent)); )
    if (e.src.charCodeAt(r) === s && !(e.sCount[f] - e.blkIndent >= 4) && (r = e.skipChars(r, s), !(r - a < l) && (r = e.skipSpaces(r), !(r < i)))) {
      y = !0;
      break;
    }
  l = e.sCount[n], e.line = f + (y ? 1 : 0);
  let u = e.push("fence", "code", 0);
  return u.info = h, u.content = e.getLines(n + 1, f, l, !0), u.markup = d, u.map = [n, e.line], !0;
}
function Si(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n], s = e.lineMax;
  if (e.sCount[n] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 62) return !1;
  if (o) return !0;
  let a = [], l = [], d = [], h = [], f = e.md.block.ruler.getRules("blockquote"), y = e.parentType;
  e.parentType = "blockquote";
  let u = !1, c;
  for (c = n; c < t; c++) {
    let x = e.sCount[c] < e.blkIndent;
    if (r = e.bMarks[c] + e.tShift[c], i = e.eMarks[c], r >= i) break;
    if (e.src.charCodeAt(r++) === 62 && !x) {
      let k = e.sCount[c] + 1, C, _;
      e.src.charCodeAt(r) === 32 ? (r++, k++, _ = !1, C = !0) : e.src.charCodeAt(r) === 9 ? (C = !0, (e.bsCount[c] + k) % 4 === 3 ? (r++, k++, _ = !1) : _ = !0) : C = !1;
      let A = k;
      for (a.push(e.bMarks[c]), e.bMarks[c] = r; r < i; ) {
        let T = e.src.charCodeAt(r);
        if (E(T))
          T === 9 ? A += 4 - (A + e.bsCount[c] + (_ ? 1 : 0)) % 4 : A++;
        else break;
        r++;
      }
      u = r >= i, l.push(e.bsCount[c]), e.bsCount[c] = e.sCount[c] + 1 + (C ? 1 : 0), d.push(e.sCount[c]), e.sCount[c] = A - k, h.push(e.tShift[c]), e.tShift[c] = r - e.bMarks[c];
      continue;
    }
    if (u) break;
    let w = !1;
    for (let k = 0, C = f.length; k < C; k++) if (f[k](e, c, t, !0)) {
      w = !0;
      break;
    }
    if (w) {
      e.lineMax = c, e.blkIndent !== 0 && (a.push(e.bMarks[c]), l.push(e.bsCount[c]), h.push(e.tShift[c]), d.push(e.sCount[c]), e.sCount[c] -= e.blkIndent);
      break;
    }
    a.push(e.bMarks[c]), l.push(e.bsCount[c]), h.push(e.tShift[c]), d.push(e.sCount[c]), e.sCount[c] = -1;
  }
  let m = e.blkIndent;
  e.blkIndent = 0;
  let p = e.push("blockquote_open", "blockquote", 1);
  p.markup = ">";
  let b = [n, 0];
  p.map = b, e.md.block.tokenize(e, n, c);
  let g = e.push("blockquote_close", "blockquote", -1);
  g.markup = ">", e.lineMax = s, e.parentType = y, b[1] = e.line;
  for (let x = 0; x < h.length; x++)
    e.bMarks[x + n] = a[x], e.tShift[x + n] = h[x], e.sCount[x + n] = d[x], e.bsCount[x + n] = l[x];
  return e.blkIndent = m, !0;
}
function Ai(e, n, t, o) {
  let r = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[n] + e.tShift[n], s = e.src.charCodeAt(i++);
  if (s !== 42 && s !== 45 && s !== 95) return !1;
  let a = 1;
  for (; i < r; ) {
    let d = e.src.charCodeAt(i++);
    if (d !== s && !E(d)) return !1;
    d === s && a++;
  }
  if (a < 3) return !1;
  if (o) return !0;
  e.line = n + 1;
  let l = e.push("hr", "hr", 0);
  return l.map = [n, e.line], l.markup = Array(a + 1).join(String.fromCharCode(s)), !0;
}
function Ct(e, n) {
  let t = e.eMarks[n], o = e.bMarks[n] + e.tShift[n], r = e.src.charCodeAt(o++);
  return r !== 42 && r !== 45 && r !== 43 || o < t && !E(e.src.charCodeAt(o)) ? -1 : o;
}
function Rt(e, n) {
  let t = e.bMarks[n] + e.tShift[n], o = e.eMarks[n], r = t;
  if (r + 1 >= o) return -1;
  let i = e.src.charCodeAt(r++);
  if (i < 48 || i > 57) return -1;
  for (; ; ) {
    if (r >= o) return -1;
    if (i = e.src.charCodeAt(r++), i >= 48 && i <= 57) {
      if (r - t >= 10) return -1;
      continue;
    }
    if (i === 41 || i === 46) break;
    return -1;
  }
  return r < o && (i = e.src.charCodeAt(r), !E(i)) ? -1 : r;
}
function Ei(e, n) {
  let t = e.level + 2;
  for (let o = n + 2, r = e.tokens.length - 2; o < r; o++) e.tokens[o].level === t && e.tokens[o].type === "paragraph_open" && (e.tokens[o + 2].hidden = !0, e.tokens[o].hidden = !0, o += 2);
}
function vi(e, n, t, o) {
  let r, i, s, a, l = n, d = !0;
  if (e.sCount[l] - e.blkIndent >= 4 || e.listIndent >= 0 && e.sCount[l] - e.listIndent >= 4 && e.sCount[l] < e.blkIndent) return !1;
  let h = !1;
  o && e.parentType === "paragraph" && e.sCount[l] >= e.blkIndent && (h = !0);
  let f, y, u;
  if ((u = Rt(e, l)) >= 0) {
    if (f = !0, s = e.bMarks[l] + e.tShift[l], y = Number(e.src.slice(s, u - 1)), h && y !== 1) return !1;
  } else if ((u = Ct(e, l)) >= 0) f = !1;
  else return !1;
  if (h && e.skipSpaces(u) >= e.eMarks[l])
    return !1;
  if (o) return !0;
  let c = e.src.charCodeAt(u - 1), m = e.tokens.length;
  f ? (a = e.push("ordered_list_open", "ol", 1), y !== 1 && (a.attrs = [["start", y]])) : a = e.push("bullet_list_open", "ul", 1);
  let p = [l, 0];
  a.map = p, a.markup = String.fromCharCode(c);
  let b = !1, g = e.md.block.ruler.getRules("list"), x = e.parentType;
  for (e.parentType = "list"; l < t; ) {
    i = u, r = e.eMarks[l];
    let w = e.sCount[l] + u - (e.bMarks[l] + e.tShift[l]), k = w;
    for (; i < r; ) {
      let v = e.src.charCodeAt(i);
      if (v === 9) k += 4 - (k + e.bsCount[l]) % 4;
      else if (v === 32) k++;
      else break;
      i++;
    }
    let C = i, _;
    C >= r ? _ = 1 : _ = k - w, _ > 4 && (_ = 1);
    let A = w + _;
    a = e.push("list_item_open", "li", 1), a.markup = String.fromCharCode(c);
    let T = [l, 0];
    a.map = T, f && (a.info = e.src.slice(s, u - 1));
    let M = e.tight, I = e.tShift[l], D = e.sCount[l], j = e.listIndent;
    if (e.listIndent = e.blkIndent, e.blkIndent = A, e.tight = !0, e.tShift[l] = C - e.bMarks[l], e.sCount[l] = k, C >= r && e.isEmpty(l + 1) ? e.line = Math.min(e.line + 2, t) : e.md.block.tokenize(e, l, t), (!e.tight || b) && (d = !1), b = e.line - l > 1 && e.isEmpty(e.line - 1), e.blkIndent = e.listIndent, e.listIndent = j, e.tShift[l] = I, e.sCount[l] = D, e.tight = M, a = e.push("list_item_close", "li", -1), a.markup = String.fromCharCode(c), l = e.line, T[1] = l, l >= t || e.sCount[l] < e.blkIndent || e.sCount[l] - e.blkIndent >= 4) break;
    let L = !1;
    for (let v = 0, wr = g.length; v < wr; v++) if (g[v](e, l, t, !0)) {
      L = !0;
      break;
    }
    if (L) break;
    if (f) {
      if (u = Rt(e, l), u < 0) break;
      s = e.bMarks[l] + e.tShift[l];
    } else if (u = Ct(e, l), u < 0) break;
    if (c !== e.src.charCodeAt(u - 1)) break;
  }
  return f ? a = e.push("ordered_list_close", "ol", -1) : a = e.push("bullet_list_close", "ul", -1), a.markup = String.fromCharCode(c), p[1] = l, e.line = l, e.parentType = x, d && Ei(e, m), !0;
}
var on = 999;
function Mi(e) {
  let n = e.length;
  for (let t = 0; t < e.length - 1; t++) {
    let o = e.charCodeAt(t);
    if (o < 55296 || o > 56319) continue;
    let r = e.charCodeAt(t + 1);
    r >= 56320 && r <= 57343 && (n--, t++);
  }
  return n;
}
function fe(e, n) {
  return Math.min(e.eMarks[n] + 1, e.src.length);
}
function Ee(e, n) {
  let t = e.lineMax;
  if (n >= t || e.isEmpty(n)) return -1;
  let o = !1;
  if (e.sCount[n] - e.blkIndent > 3 && (o = !0), e.sCount[n] < 0 && (o = !0), !o) {
    let r = e.md.block.ruler.getRules("reference"), i = e.parentType;
    e.parentType = "reference";
    let s = !1;
    for (let a = 0, l = r.length; a < l; a++) if (r[a](e, n, t, !0)) {
      s = !0;
      break;
    }
    if (e.parentType = i, s) return -1;
  }
  return e.bMarks[n] + e.tShift[n];
}
function Di(e, n, t, o) {
  let r = e.src, i = e.bMarks[n] + e.tShift[n], s = n + 1;
  if (e.sCount[n] - e.blkIndent >= 4 || r.charCodeAt(i) !== 91) return !1;
  let a = fe(e, n), l = "", d = -1, h = ++i;
  for (; i < a; ) {
    if (l.length + i - h > on * 2) return !1;
    let C = r.charCodeAt(i);
    if (C === 91) return !1;
    if (C === 93) {
      d = i;
      break;
    }
    if (C === 92 && (C = r.charCodeAt(++i)), C === 10 && i < a) {
      let _ = Ee(e, s);
      if (_ < 0) return !1;
      l += r.slice(h, a), i = h = _, a = fe(e, s++);
      continue;
    }
    i++;
  }
  if (d < 0 || r.charCodeAt(d + 1) !== 58 || (l += r.slice(h, d), l.length > on && Mi(l) > on)) return !1;
  for (i = d + 2; i < a; ) {
    let C = r.charCodeAt(i);
    if (C === 10) {
      let _ = Ee(e, s);
      if (_ < 0) break;
      i = _, a = fe(e, s++);
    } else if (E(C)) i++;
    else break;
  }
  let f = e.md.helpers.parseLinkDestination(r, i, a);
  if (!f.ok) return !1;
  let y = e.md.normalizeLink(f.str);
  if (!e.md.validateLink(y)) return !1;
  i = f.pos;
  let u = i, c = a, m = s;
  for (; i < a; ) {
    let C = r.charCodeAt(i);
    if (C === 10) {
      let _ = Ee(e, s);
      if (_ < 0) break;
      i = _, a = fe(e, s++);
    } else if (E(C)) i++;
    else break;
  }
  let p = i, b = e.md.helpers.parseLinkTitle(r, i, a);
  for (; b.can_continue; ) {
    let C = Ee(e, s);
    if (C < 0) break;
    i = C, a = fe(e, s++), b = e.md.helpers.parseLinkTitle(r, i, a, b);
  }
  let g;
  for (p !== u && b.ok ? (g = b.str, i = b.pos) : (g = "", i = u, a = c, s = m); i < a && E(r.charCodeAt(i)); )
    i++;
  if (i < a && r.charCodeAt(i) !== 10 && g)
    for (g = "", i = u, a = c, s = m; i < a && E(r.charCodeAt(i)); )
      i++;
  if (i < a && r.charCodeAt(i) !== 10) return !1;
  let x = Me(l);
  if (!x) return !1;
  if (o) return !0;
  typeof e.env.references > "u" && (e.env.references = {}), typeof e.env.references[x] > "u" && (e.env.references[x] = {
    title: g,
    href: y
  });
  let w = e.push("reference_definition", "", 0);
  w.map = [n, s], w.hidden = !0;
  let k = /* @__PURE__ */ Object.create(null);
  return k.label = x, w.meta = k, e.line = s, !0;
}
var Pi = [
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
], Lt = `<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`, Bt = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>";
new RegExp(`^(?:${Lt}|${Bt}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`);
var Ut = new RegExp(`^(?:${Lt}|${Bt})`), Q = [
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
    new RegExp(`^</?(${Pi.join("|")})(?=(\\s|/?>|$))`, "i"),
    /^$/,
    !0
  ],
  [
    new RegExp(`${Ut.source}\\s*$`),
    /^$/,
    !1
  ]
];
function Oi(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4 || !e.md.options.html || e.src.charCodeAt(r) !== 60) return !1;
  let s = e.src.slice(r, i), a = 0;
  for (; a < Q.length && !Q[a][0].test(s); a++) ;
  if (a === Q.length) return !1;
  if (o) return Q[a][2];
  let l = n + 1, d = Q[a][1].test("");
  if (!Q[a][1].test(s)) {
    for (; l < t && !(e.sCount[l] < e.blkIndent && (d || !e.isEmpty(l))); l++)
      if (r = e.bMarks[l] + e.tShift[l], i = e.eMarks[l], s = e.src.slice(r, i), Q[a][1].test(s)) {
        s.length !== 0 && l++;
        break;
      }
  }
  e.line = l;
  let h = e.push("html_block", "", 0);
  return h.map = [n, l], h.content = e.getLines(n, l, e.blkIndent, !0), !0;
}
function Fi(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let s = e.src.charCodeAt(r);
  if (s !== 35 || r >= i) return !1;
  let a = 1;
  for (s = e.src.charCodeAt(++r); s === 35 && r < i && a <= 6; )
    a++, s = e.src.charCodeAt(++r);
  if (a > 6 || r < i && !E(s)) return !1;
  if (o) return !0;
  i = e.skipSpacesBack(i, r);
  let l = e.skipCharsBack(i, 35, r);
  l > r && E(e.src.charCodeAt(l - 1)) && (i = l), e.line = n + 1;
  let d = e.push("heading_open", `h${a}`, 1);
  d.markup = "########".slice(0, a), d.map = [n, e.line];
  let h = e.push("inline", "", 0);
  h.content = De(e.src.slice(r, i)), h.map = [n, e.line], h.children = [];
  let f = e.push("heading_close", `h${a}`, -1);
  return f.markup = "########".slice(0, a), !0;
}
function Ni(e, n, t) {
  let o = e.md.block.ruler.getRules("paragraph");
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let r = e.parentType;
  e.parentType = "paragraph";
  let i = 0, s, a = n + 1;
  for (; a < t && !e.isEmpty(a); a++) {
    if (e.sCount[a] - e.blkIndent > 3) continue;
    if (e.sCount[a] >= e.blkIndent) {
      let u = e.bMarks[a] + e.tShift[a], c = e.eMarks[a];
      if (u < c && (s = e.src.charCodeAt(u), (s === 45 || s === 61) && (u = e.skipChars(u, s), u = e.skipSpaces(u), u >= c))) {
        i = s === 61 ? 1 : 2;
        break;
      }
    }
    if (e.sCount[a] < 0) continue;
    let y = !1;
    for (let u = 0, c = o.length; u < c; u++) if (o[u](e, a, t, !0)) {
      y = !0;
      break;
    }
    if (y) break;
  }
  if (!i)
    return e.parentType = r, !1;
  let l = De(e.getLines(n, a, e.blkIndent, !1));
  e.line = a + 1;
  let d = e.push("heading_open", `h${i}`, 1);
  d.markup = String.fromCharCode(s), d.map = [n, e.line];
  let h = e.push("inline", "", 0);
  h.content = l, h.map = [n, e.line - 1], h.children = [];
  let f = e.push("heading_close", `h${i}`, -1);
  return f.markup = String.fromCharCode(s), e.parentType = r, !0;
}
function Li(e, n, t) {
  let o = e.md.block.ruler.getRules("paragraph"), r = e.parentType, i = n + 1;
  for (e.parentType = "paragraph"; i < t && !e.isEmpty(i); i++) {
    if (e.sCount[i] - e.blkIndent > 3 || e.sCount[i] < 0) continue;
    let d = !1;
    for (let h = 0, f = o.length; h < f; h++) if (o[h](e, i, t, !0)) {
      d = !0;
      break;
    }
    if (d) break;
  }
  let s = De(e.getLines(n, i, e.blkIndent, !1));
  e.line = i;
  let a = e.push("paragraph_open", "p", 1);
  a.map = [n, e.line];
  let l = e.push("inline", "", 0);
  return l.content = s, l.map = [n, e.line], l.children = [], e.push("paragraph_close", "p", -1), e.parentType = r, !0;
}
var ve = [
  [
    "table",
    _i,
    ["paragraph", "reference"]
  ],
  ["code", Ti],
  [
    "fence",
    Ii,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "blockquote",
    Si,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "hr",
    Ai,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "list",
    vi,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["reference", Di],
  [
    "html_block",
    Oi,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  [
    "heading",
    Fi,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["lheading", Ni],
  ["paragraph", Li]
], jt = class {
  constructor() {
    R(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of block rules.
      */
      "ruler",
      new xe()
    ), R(this, "State", Nt);
    for (let e = 0; e < ve.length; e++) this.ruler.push(ve[e][0], ve[e][1], { alt: (ve[e][2] || []).slice() });
  }
  tokenize(e, n, t) {
    let o = this.ruler.getRules(""), r = o.length, i = e.md.options.maxNesting, s = n, a = !1;
    for (; s < t && (e.line = s = e.skipEmptyLines(s), !(s >= t || e.sCount[s] < e.blkIndent)); ) {
      if (e.level >= i) {
        e.line = t;
        break;
      }
      let l = e.line, d = !1;
      for (let h = 0; h < r; h++)
        if (d = o[h](e, s, t, !1), d) {
          if (l >= e.line) throw new Error("block rule didn't increment state.line");
          break;
        }
      if (!d) throw new Error("none of the block rules matched");
      e.tight = !a, e.isEmpty(e.line - 1) && (a = !0), s = e.line, s < t && e.isEmpty(s) && (a = !0, s++, e.line = s);
    }
  }
  /**
  * Process input string and push block tokens into `outTokens`
  */
  parse(e, n, t, o) {
    if (!e) return;
    let r = new this.State(e, n, t, o);
    this.tokenize(r, r.line, r.lineMax);
  }
}, zt = class {
  constructor(e, n, t, o) {
    R(this, "pos", 0), R(this, "level", 0), R(this, "pending", ""), R(this, "pendingLevel", 0), R(this, "cache", {}), R(this, "backticks", {}), R(this, "backticksScanned", !1), R(this, "skipHtmlSpecial", !1), R(this, "linkLevel", 0), R(this, "delimiters", []), R(this, "_prev_delimiters", []), R(this, "Token", ee), this.src = e, this.env = t, this.md = n, this.tokens = o, this.tokens_meta = Array(o.length), this.posMax = this.src.length;
  }
  pushPending() {
    let e = new ee("text", "", 0);
    return e.content = this.pending, e.level = this.pendingLevel, this.tokens.push(e), this.pending = "", e;
  }
  push(e, n, t) {
    this.pending && this.pushPending();
    let o = new ee(e, n, t), r;
    return t < 0 && (this.level--, this.delimiters = this._prev_delimiters.pop()), o.level = this.level, t > 0 && (this.level++, this._prev_delimiters.push(this.delimiters), this.delimiters = [], r = { delimiters: this.delimiters }), this.pendingLevel = this.level, this.tokens.push(o), this.tokens_meta.push(r), o;
  }
  scanDelims(e, n) {
    let t = this.posMax, o = this.src.charCodeAt(e), r;
    if (e === 0) r = 32;
    else if (e === 1)
      r = this.src.charCodeAt(0), (r & 63488) === 55296 && (r = 65533);
    else if (r = this.src.charCodeAt(e - 1), (r & 64512) === 56320) {
      let c = this.src.charCodeAt(e - 2);
      r = (c & 64512) === 55296 ? 65536 + (c - 55296 << 10) + (r - 56320) : 65533;
    } else (r & 64512) === 55296 && (r = 65533);
    let i = e;
    for (; i < t && this.src.charCodeAt(i) === o; ) i++;
    let s = i - e, a = i < t ? this.src.charCodeAt(i) : 32;
    if ((a & 64512) === 55296) {
      let c = this.src.charCodeAt(i + 1);
      a = (c & 64512) === 56320 ? 65536 + (a - 55296 << 10) + (c - 56320) : 65533;
    } else (a & 64512) === 56320 && (a = 65533);
    let l = ye(r) || me(r), d = ye(a) || me(a), h = he(r), f = he(a), y = !f && (!d || h || l), u = !h && (!l || f || d);
    return {
      can_open: y && (n || !u || l),
      can_close: u && (n || !y || d),
      length: s
    };
  }
};
function Bi(e) {
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
function Ui(e, n) {
  let t = e.pos;
  for (; t < e.posMax && !Bi(e.src.charCodeAt(t)); ) t++;
  return t === e.pos ? !1 : (n || (e.pending += e.src.slice(e.pos, t)), e.pos = t, !0);
}
function ji(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122;
}
function zi(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122 || e >= 48 && e <= 57 || e === 43 || e === 45 || e === 46;
}
function $i(e, n) {
  if (!e.md.options.linkify || e.linkLevel > 0) return !1;
  let t = e.pos, o = e.posMax;
  if (t + 3 > o || e.src.charCodeAt(t) !== 58 || e.src.charCodeAt(t + 1) !== 47 || e.src.charCodeAt(t + 2) !== 47) return !1;
  let r = t - Math.min(10, e.pending.length, t), i = t;
  for (; i > r && zi(e.src.charCodeAt(i - 1)); ) i--;
  if (i === t || !ji(e.src.charCodeAt(i))) return !1;
  let s = t - i, a = e.md.linkify.matchAtStart(e.src.slice(i));
  if (!a) return !1;
  let l = a.url;
  if (l.length <= s) return !1;
  let d = l.length;
  for (; d > 0 && l.charCodeAt(d - 1) === 42; ) d--;
  d !== l.length && (l = l.slice(0, d));
  let h = e.md.normalizeLink(l);
  if (!e.md.validateLink(h)) return !1;
  if (!n) {
    e.pending = e.pending.slice(0, -s);
    let f = e.push("link_open", "a", 1);
    f.attrs = [["href", h]], f.markup = "linkify", f.info = "auto";
    let y = e.push("text", "", 0);
    y.content = e.md.normalizeLinkText(l);
    let u = e.push("link_close", "a", -1);
    u.markup = "linkify", u.info = "auto";
  }
  return e.pos += l.length - s, !0;
}
function Wi(e, n) {
  let t = e.pos;
  if (e.src.charCodeAt(t) !== 10) return !1;
  let o = e.pending.length - 1, r = e.posMax;
  if (!n)
    if (o >= 0 && e.pending.charCodeAt(o) === 32)
      if (o >= 1 && e.pending.charCodeAt(o - 1) === 32) {
        let i = o - 1;
        for (; i >= 1 && e.pending.charCodeAt(i - 1) === 32; ) i--;
        e.pending = e.pending.slice(0, i), e.push("hardbreak", "br", 0);
      } else
        e.pending = e.pending.slice(0, -1), e.push("softbreak", "br", 0);
    else e.push("softbreak", "br", 0);
  for (t++; t < r && E(e.src.charCodeAt(t)); ) t++;
  return e.pos = t, !0;
}
var ln = [];
for (let e = 0; e < 256; e++) ln.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(e) {
  ln[e.charCodeAt(0)] = 1;
});
function qi(e, n) {
  let t = e.pos, o = e.posMax;
  if (e.src.charCodeAt(t) !== 92 || (t++, t >= o)) return !1;
  let r = e.src.charCodeAt(t);
  if (r === 10) {
    for (n || e.push("hardbreak", "br", 0), t++; t < o && (r = e.src.charCodeAt(t), !!E(r)); )
      t++;
    return e.pos = t, !0;
  }
  if (r === 32) {
    if (!n) {
      let a = e.push("text_special", "", 0);
      a.content = "\\", a.markup = "\\", a.info = "escape";
    }
    return e.pos = t, !0;
  }
  let i = e.src[t];
  if (r >= 55296 && r <= 56319 && t + 1 < o) {
    let a = e.src.charCodeAt(t + 1);
    a >= 56320 && a <= 57343 && (i += e.src[t + 1], t++);
  }
  let s = "\\" + i;
  if (!n) {
    let a = e.push("text_special", "", 0);
    r < 256 && ln[r] !== 0 ? a.content = i : a.content = s, a.markup = s, a.info = "escape";
  }
  return e.pos = t + 1, !0;
}
function Gi(e) {
  let n = {}, t = 0;
  for (; (t = e.indexOf("`", t)) !== -1; ) {
    let o = t;
    for (; e.charCodeAt(++t) === 96; ) ;
    n[t - o] = o;
  }
  return n;
}
function Ji(e, n) {
  var t;
  let o = e.pos;
  if (e.src.charCodeAt(o) !== 96) return !1;
  let r = e.posMax, i = o + 1;
  for (; i < r && e.src.charCodeAt(i) === 96; ) i++;
  let s = e.src.slice(o, i), a = s.length;
  if (e.backticksScanned || (e.backticks = Gi(e.src), e.backticksScanned = !0), ((t = e.backticks[a]) !== null && t !== void 0 ? t : -1) >= i) {
    let l = i, d;
    for (; (d = e.src.indexOf("`", l)) !== -1 && d < r; ) {
      for (l = d + 1; e.src.charCodeAt(l) === 96; ) l++;
      if (l > r) break;
      if (l - d === a) {
        if (!n) {
          let h = e.push("code_inline", "code", 0);
          h.markup = s;
          let f = e.src.slice(i, d).replace(/\n/g, " ");
          f.startsWith(" ") && f.endsWith(" ") && /[^ ]/.test(f) && (f = f.slice(1, -1)), h.content = f;
        }
        return e.pos = l, !0;
      }
    }
  }
  return n || (e.pending += s), e.pos = i, !0;
}
function Ki(e, n) {
  let t = e.pos, o = e.src.charCodeAt(t);
  if (n || o !== 126) return !1;
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
function _t(e, n) {
  let t, o = [], r = n.length;
  for (let i = 0; i < r; i++) {
    let s = n[i];
    if (s.marker !== 126 || s.end === -1) continue;
    let a = n[s.end];
    t = e.tokens[s.token], t.type = "s_open", t.tag = "s", t.nesting = 1, t.markup = "~~", t.content = "", t = e.tokens[a.token], t.type = "s_close", t.tag = "s", t.nesting = -1, t.markup = "~~", t.content = "", e.tokens[a.token - 1].type === "text" && e.tokens[a.token - 1].content === "~" && o.push(a.token - 1);
  }
  for (; o.length; ) {
    let i = o.pop(), s = i + 1;
    for (; s < e.tokens.length && e.tokens[s].type === "s_close"; ) s++;
    s--, i !== s && (t = e.tokens[s], e.tokens[s] = e.tokens[i], e.tokens[i] = t);
  }
}
function Hi(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  _t(e, e.delimiters);
  for (let r = 0; r < t; r++) {
    var o;
    let i = (o = n[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && _t(e, i);
  }
}
var $t = {
  tokenize: Ki,
  postProcess: Hi
};
function Xi(e, n) {
  let t = e.pos, o = e.src.charCodeAt(t);
  if (n || o !== 95 && o !== 42) return !1;
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
function Tt(e, n) {
  let t = n.length;
  for (let o = t - 1; o >= 0; o--) {
    let r = n[o];
    if (r.marker !== 95 && r.marker !== 42 || r.end === -1) continue;
    let i = n[r.end], s = o > 0 && n[o - 1].end === r.end + 1 && n[o - 1].marker === r.marker && n[o - 1].token === r.token - 1 && n[r.end + 1].token === i.token + 1, a = String.fromCharCode(r.marker), l = e.tokens[r.token];
    l.type = s ? "strong_open" : "em_open", l.tag = s ? "strong" : "em", l.nesting = 1, l.markup = s ? a + a : a, l.content = "";
    let d = e.tokens[i.token];
    d.type = s ? "strong_close" : "em_close", d.tag = s ? "strong" : "em", d.nesting = -1, d.markup = s ? a + a : a, d.content = "", s && (e.tokens[n[o - 1].token].content = "", e.tokens[n[r.end + 1].token].content = "", o--);
  }
}
function Vi(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  Tt(e, e.delimiters);
  for (let r = 0; r < t; r++) {
    var o;
    let i = (o = n[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Tt(e, i);
  }
}
var Wt = {
  tokenize: Xi,
  postProcess: Vi
};
function Yi(e, n) {
  let t, o, r, i, s = "", a = "", l = e.pos, d = !0;
  if (e.src.charCodeAt(e.pos) !== 91) return !1;
  let h = e.pos, f = e.posMax, y = e.pos + 1, u = e.md.helpers.parseLinkLabel(e, e.pos, !0);
  if (u < 0) return !1;
  let c = u + 1;
  if (c < f && e.src.charCodeAt(c) === 40) {
    for (d = !1, c++; c < f && (t = e.src.charCodeAt(c), !(!E(t) && t !== 10)); c++)
      ;
    if (c >= f) return !1;
    if (l = c, r = e.md.helpers.parseLinkDestination(e.src, c, e.posMax), r.ok) {
      for (s = e.md.normalizeLink(r.str), e.md.validateLink(s) ? c = r.pos : s = "", l = c; c < f && (t = e.src.charCodeAt(c), !(!E(t) && t !== 10)); c++)
        ;
      if (r = e.md.helpers.parseLinkTitle(e.src, c, e.posMax), c < f && l !== c && r.ok)
        for (a = r.str, c = r.pos; c < f && (t = e.src.charCodeAt(c), !(!E(t) && t !== 10)); c++)
          ;
    }
    (c >= f || e.src.charCodeAt(c) !== 41) && (d = !0), c++;
  }
  if (d) {
    if (typeof e.env.references > "u") return !1;
    if (c < f && e.src.charCodeAt(c) === 91 ? (l = c + 1, c = e.md.helpers.parseLinkLabel(e, c), c >= 0 ? o = e.src.slice(l, c++) : c = u + 1) : c = u + 1, o || (o = e.src.slice(y, u)), o = Me(o), i = e.env.references[o], !i)
      return e.pos = h, !1;
    s = i.href, a = i.title;
  }
  if (!n) {
    e.pos = y, e.posMax = u;
    let m = e.push("link_open", "a", 1), p = [["href", s]];
    if (m.attrs = p, a && p.push(["title", a]), o) {
      let b = /* @__PURE__ */ Object.create(null);
      b.label = o, m.meta = b;
    }
    e.linkLevel++, e.md.inline.tokenize(e), e.linkLevel--, e.push("link_close", "a", -1);
  }
  return e.pos = c, e.posMax = f, !0;
}
function Zi(e, n) {
  let t, o, r, i, s, a, l, d, h = "", f = e.pos, y = e.posMax;
  if (e.src.charCodeAt(e.pos) !== 33 || e.src.charCodeAt(e.pos + 1) !== 91) return !1;
  let u = e.pos + 2, c = e.md.helpers.parseLinkLabel(e, e.pos + 1, !1);
  if (c < 0) return !1;
  if (i = c + 1, i < y && e.src.charCodeAt(i) === 40) {
    for (i++; i < y && (t = e.src.charCodeAt(i), !(!E(t) && t !== 10)); i++)
      ;
    if (i >= y) return !1;
    for (d = i, a = e.md.helpers.parseLinkDestination(e.src, i, e.posMax), a.ok && (h = e.md.normalizeLink(a.str), e.md.validateLink(h) ? i = a.pos : h = ""), d = i; i < y && (t = e.src.charCodeAt(i), !(!E(t) && t !== 10)); i++)
      ;
    if (a = e.md.helpers.parseLinkTitle(e.src, i, e.posMax), i < y && d !== i && a.ok)
      for (l = a.str, i = a.pos; i < y && (t = e.src.charCodeAt(i), !(!E(t) && t !== 10)); i++)
        ;
    else l = "";
    if (i >= y || e.src.charCodeAt(i) !== 41)
      return e.pos = f, !1;
    i++;
  } else {
    if (typeof e.env.references > "u") return !1;
    if (i < y && e.src.charCodeAt(i) === 91 ? (d = i + 1, i = e.md.helpers.parseLinkLabel(e, i), i >= 0 ? r = e.src.slice(d, i++) : i = c + 1) : i = c + 1, r || (r = e.src.slice(u, c)), r = Me(r), s = e.env.references[r], !s)
      return e.pos = f, !1;
    h = s.href, l = s.title;
  }
  if (!n) {
    o = e.src.slice(u, c);
    let m = [];
    e.md.inline.parse(o, e.md, e.env, m);
    let p = e.push("image", "img", 0), b = [["src", h], ["alt", ""]];
    if (p.attrs = b, p.children = m, p.content = o, l && b.push(["title", l]), r) {
      let g = /* @__PURE__ */ Object.create(null);
      g.label = r, p.meta = g;
    }
  }
  return e.pos = i, e.posMax = y, !0;
}
var Qi = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/, es = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function ns(e, n) {
  let t = e.pos;
  if (e.src.charCodeAt(t) !== 60) return !1;
  let o = e.pos, r = e.posMax;
  for (; ; ) {
    if (++t >= r) return !1;
    let s = e.src.charCodeAt(t);
    if (s === 60) return !1;
    if (s === 62) break;
  }
  let i = e.src.slice(o + 1, t);
  if (es.test(i)) {
    let s = e.md.normalizeLink(i);
    if (!e.md.validateLink(s)) return !1;
    if (!n) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let l = e.push("text", "", 0);
      l.content = e.md.normalizeLinkText(i);
      let d = e.push("link_close", "a", -1);
      d.markup = "autolink", d.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  if (Qi.test(i)) {
    let s = e.md.normalizeLink(`mailto:${i}`);
    if (!e.md.validateLink(s)) return !1;
    if (!n) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let l = e.push("text", "", 0);
      l.content = e.md.normalizeLinkText(i);
      let d = e.push("link_close", "a", -1);
      d.markup = "autolink", d.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  return !1;
}
function ts(e) {
  return /^<a[>\s]/i.test(e);
}
function rs(e) {
  return /^<\/a\s*>/i.test(e);
}
function qt(e) {
  let n = e | 32;
  return n >= 97 && n <= 122;
}
function os(e, n) {
  let t = e.src, o, r;
  if (t.startsWith("<!--", n)) {
    if (t.startsWith(">", n + 4)) return n + 5;
    if (t.startsWith("->", n + 4)) return n + 6;
    o = n + 4, r = "-->";
  } else if (t.startsWith("<![CDATA[", n))
    o = n + 9, r = "]]>";
  else if (t.charCodeAt(n + 1) === 63)
    o = n + 2, r = "?>";
  else if (qt(t.charCodeAt(n + 2)))
    o = n + 3, r = ">";
  else return -1;
  if (e.skipHtmlSpecial) return -1;
  let i = t.indexOf(r, o);
  return i < 0 ? (e.skipHtmlSpecial = !0, -1) : i + r.length;
}
function is(e, n) {
  if (!e.md.options.html) return !1;
  let t = e.posMax, o = e.pos;
  if (e.src.charCodeAt(o) !== 60 || o + 2 >= t) return !1;
  let r, i = e.src.charCodeAt(o + 1);
  if (i === 33 || i === 63) r = os(e, o);
  else if (i === 47 || qt(i)) {
    let s = e.src.slice(o).match(Ut);
    r = s ? o + s[0].length : -1;
  } else return !1;
  if (r < 0) return !1;
  if (!n) {
    let s = e.push("html_inline", "", 0);
    s.content = e.src.slice(o, r), ts(s.content) && e.linkLevel++, rs(s.content) && e.linkLevel--;
  }
  return e.pos = r, !0;
}
var ss = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i, as = /^&([a-z][a-z0-9]{1,31});/i;
function us(e, n) {
  let t = e.pos, o = e.posMax;
  if (e.src.charCodeAt(t) !== 38 || t + 1 >= o) return !1;
  if (e.src.charCodeAt(t + 1) === 35) {
    let r = e.src.slice(t).match(ss);
    if (r) {
      if (!n) {
        let i = r[1][0].toLowerCase() === "x" ? parseInt(r[1].slice(1), 16) : parseInt(r[1], 10), s = e.push("text_special", "", 0);
        s.content = cn(i) ? ge(i) : ge(65533), s.markup = r[0], s.info = "entity";
      }
      return e.pos += r[0].length, !0;
    }
  } else {
    let r = e.src.slice(t).match(as);
    if (r) {
      let i = Se(r[0]);
      if (i !== r[0]) {
        if (!n) {
          let s = e.push("text_special", "", 0);
          s.content = i, s.markup = r[0], s.info = "entity";
        }
        return e.pos += r[0].length, !0;
      }
    }
  }
  return !1;
}
function It(e) {
  let n = {}, t = e.length;
  if (!t) return;
  let o = 0, r = -2, i = [];
  for (let s = 0; s < t; s++) {
    let a = e[s];
    if (i.push(0), (e[o].marker !== a.marker || r !== a.token - 1) && (o = s), r = a.token, a.length = a.length || 0, !a.close) continue;
    n.hasOwnProperty(a.marker) || (n[a.marker] = [
      -1,
      -1,
      -1,
      -1,
      -1,
      -1
    ]);
    let l = n[a.marker][(a.open ? 3 : 0) + a.length % 3], d = o - i[o] - 1, h = d;
    for (; d > l; d -= i[d] + 1) {
      let f = e[d];
      if (f.marker === a.marker && f.open && f.end < 0) {
        let y = !1;
        if ((f.close || a.open) && (f.length + a.length) % 3 === 0 && (f.length % 3 !== 0 || a.length % 3 !== 0) && (y = !0), !y) {
          let u = d > 0 && !e[d - 1].open ? i[d - 1] + 1 : 0;
          i[s] = s - d + u, i[d] = u, a.open = !1, f.end = s, f.close = !1, h = -1, r = -2;
          break;
        }
      }
    }
    h !== -1 && (n[a.marker][(a.open ? 3 : 0) + (a.length || 0) % 3] = h);
  }
}
function cs(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  It(e.delimiters);
  for (let r = 0; r < t; r++) {
    var o;
    let i = (o = n[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && It(i);
  }
}
function ls(e) {
  let n, t, o = 0, r = e.tokens, i = e.tokens.length;
  for (n = t = 0; n < i; n++)
    r[n].nesting < 0 && o--, r[n].level = o, r[n].nesting > 0 && o++, r[n].type === "text" && n + 1 < i && r[n + 1].type === "text" ? r[n + 1].content = r[n].content + r[n + 1].content : (n !== t && (r[t] = r[n]), t++);
  n !== t && (r.length = t);
}
var sn = [
  ["text", Ui],
  ["linkify", $i],
  ["newline", Wi],
  ["escape", qi],
  ["backticks", Ji],
  ["strikethrough", $t.tokenize],
  ["emphasis", Wt.tokenize],
  ["link", Yi],
  ["image", Zi],
  ["autolink", ns],
  ["html_inline", is],
  ["entity", us]
], an = [
  ["balance_pairs", cs],
  ["strikethrough", $t.postProcess],
  ["emphasis", Wt.postProcess],
  ["fragments_join", ls]
], Gt = class {
  constructor() {
    R(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of inline rules.
      */
      "ruler",
      new xe()
    ), R(
      this,
      /**
      * {@link Ruler} instance. Second ruler used for post-processing
      * (e.g. in emphasis-like rules).
      */
      "ruler2",
      new xe()
    ), R(this, "State", zt);
    for (let e = 0; e < sn.length; e++) this.ruler.push(sn[e][0], sn[e][1]);
    for (let e = 0; e < an.length; e++) this.ruler2.push(an[e][0], an[e][1]);
  }
  skipToken(e) {
    let n = e.pos, t = this.ruler.getRules(""), o = t.length, r = e.md.options.maxNesting, i = e.cache;
    if (typeof i[n] < "u") {
      e.pos = i[n];
      return;
    }
    let s = !1;
    if (e.level < r) {
      for (let a = 0; a < o; a++)
        if (e.level++, s = t[a](e, !0), e.level--, s) {
          if (n >= e.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
    } else e.pos = e.posMax;
    s || e.pos++, i[n] = e.pos;
  }
  tokenize(e) {
    let n = this.ruler.getRules(""), t = n.length, o = e.posMax, r = e.md.options.maxNesting;
    for (; e.pos < o; ) {
      let i = e.pos, s = !1;
      if (e.level < r) {
        for (let a = 0; a < t; a++)
          if (s = n[a](e, !1), s) {
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
  parse(e, n, t, o) {
    let r = new this.State(e, n, t, o);
    this.tokenize(r);
    let i = this.ruler2.getRules(""), s = i.length;
    for (let a = 0; a < s; a++) i[a](r);
  }
}, ds = {
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
}, ps = /^(vbscript|javascript|file|data):/, fs = /^data:image\/(gif|png|jpeg|webp);/, St = [
  "http:",
  "https:",
  "mailto:"
], G = class {
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
    let n = e.trim().toLowerCase();
    return ps.test(n) ? fs.test(n) : !0;
  }
  /**
  * Function used to encode link url to a machine-readable format,
  * which includes url-encoding, punycode, etc.
  */
  normalizeLink(e) {
    let n = de(e, !0);
    if (n.hostname && (!n.protocol || St.indexOf(n.protocol) >= 0))
      try {
        n.hostname = un.default.toASCII(n.hostname);
      } catch {
      }
    return n.auth && (n.auth = J(n.auth)), n.hostname && (n.hostname = J(n.hostname)), n.pathname && (n.pathname = J(n.pathname)), n.search && (n.search = J(n.search)), n.hash && (n.hash = J(n.hash)), oe(n);
  }
  /**
  * Function used to decode link url to a human-readable format`
  */
  normalizeLinkText(e) {
    let n = de(e, !0);
    if (n.hostname && (!n.protocol || St.indexOf(n.protocol) >= 0))
      try {
        n.hostname = un.default.toUnicode(n.hostname);
      } catch {
      }
    return le(oe(n), le.defaultChars + "%");
  }
  constructor(...e) {
    R(
      this,
      /**
      * Instance of {@link ParserInline}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "inline",
      new Gt()
    ), R(
      this,
      /**
      * Instance of {@link ParserBlock}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "block",
      new jt()
    ), R(
      this,
      /**
      * Instance of {@link ParserCore} chain executor. You may need it to add new
      * rules when writing plugins. For simple rules control use
      * {@link MarkdownIt.disable} and {@link MarkdownIt.enable}.
      */
      "core",
      new Ft()
    ), R(
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
      new Dt()
    ), R(
      this,
      /**
      * [linkify-it](https://github.com/markdown-it/linkify-it) instance.
      * Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/src/rules_core/linkify.ts)
      * rule.
      */
      "linkify",
      new at()
    ), R(
      this,
      /**
      * Assorted utility functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/common/utils.ts).
      */
      "utils",
      Fo
    ), R(
      this,
      /**
      * Link components parser functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/helpers).
      */
      "helpers",
      Object.assign({}, Yo)
    );
    let [n, t] = e;
    typeof n == "string" ? (this.configure(n), t && this.set(t)) : (this.configure("default"), this.set(n || {}));
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
    let n;
    if (typeof e == "string") {
      let r = e;
      if (n = ds[r], !n) throw new Error(`Wrong 'markdown-it' preset "${r}", check name`);
    } else n = e;
    if (!n) throw new Error("Wrong `markdown-it` preset, can't be empty");
    n.options && (this.options = { ...n.options });
    let t = n.components;
    if (t) {
      var o;
      [
        "core",
        "block",
        "inline"
      ].forEach((i) => {
        var s;
        let a = (s = t[i]) === null || s === void 0 ? void 0 : s.rules;
        a && this[i].ruler.enableOnly(a);
      });
      let r = (o = t.inline) === null || o === void 0 ? void 0 : o.rules2;
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
  enable(e, n = !1) {
    let t = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((r) => {
      t = t.concat(this[r].ruler.enable(e, !0));
    }), t = t.concat(this.inline.ruler2.enable(e, !0));
    let o = e.filter((r) => t.indexOf(r) < 0);
    if (o.length && !n) throw new Error(`MarkdownIt. Failed to enable unknown rule(s): ${o}`);
    return this;
  }
  /**
  * The same as {@link MarkdownIt.enable}, but turn specified rules off.
  */
  disable(e, n = !1) {
    let t = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((r) => {
      t = t.concat(this[r].ruler.disable(e, !0));
    }), t = t.concat(this.inline.ruler2.disable(e, !0));
    let o = e.filter((r) => t.indexOf(r) < 0);
    if (o.length && !n) throw new Error(`MarkdownIt. Failed to disable unknown rule(s): ${o}`);
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
  use(e, ...n) {
    return e.apply(e, [this, ...n]), this;
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
  parse(e, n) {
    if (typeof e != "string") throw new Error("Input data should be a String");
    let t = new this.core.State(e, this, n);
    return this.core.process(t), t.tokens;
  }
  /**
  * Render markdown string into html. It does all magic for you :).
  *
  * `env` can be used to inject additional metadata (`{}` by default).
  * But you will not need it with high probability. See also comment
  * in {@link MarkdownIt.parse}.
  */
  render(e, n = {}) {
    return this.renderer.render(this.parse(e, n), this.options, n);
  }
  /**
  * The same as {@link MarkdownIt.parse} but skip all block rules. It returns
  * the block tokens list with the single `inline` element, containing parsed
  * inline tokens in `children` property. Also updates `env` object.
  */
  parseInline(e, n) {
    let t = new this.core.State(e, this, n);
    return t.inlineMode = !0, this.core.process(t), t.tokens;
  }
  /**
  * Similar to {@link MarkdownIt.render} but for single paragraph content.
  * Result will NOT be wrapped into `<p>` tags.
  */
  renderInline(e, n = {}) {
    return this.renderer.render(this.parseInline(e, n), this.options, n);
  }
};
R(G, "Token", ee);
R(G, "Ruler", xe);
R(G, "Renderer", Dt);
R(G, "ParserCore", Ft);
R(G, "StateCore", Pt);
R(G, "ParserBlock", jt);
R(G, "StateBlock", Nt);
R(G, "ParserInline", Gt);
R(G, "StateInline", zt);
var gs = Et(G);

// openclaw/packages/net-policy/src/ip.ts
var Ht = hn(Kt(), 1);
var Kl = [Ht.default.IPv4.parse("198.18.0.0"), 15];

// openclaw/packages/tool-call-repair/src/grammar.ts
var Zl = new TextEncoder();

// openclaw/src/shared/clawhub-recommendations.ts
var Xt = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind"
], zd = /* @__PURE__ */ new Set([...Xt, "pluginId"]), $d = /* @__PURE__ */ new Set([...Xt, "registry", "skillRef"]);

// openclaw/src/shared/plugin-inline-view.ts
var Gd = 16 * 1024;

// openclaw/ui/src/lib/chat/message-normalizer.ts
function dn(e) {
  return we(P(e)?.role);
}

// openclaw/ui/src/lib/chat/tool-call-diff.ts
function Vt(e) {
  let n = V(e), t = n?.added, o = n?.removed;
  return typeof t == "number" && Number.isInteger(t) && t >= 0 && typeof o == "number" && Number.isInteger(o) && o >= 0 ? { added: t, removed: o } : void 0;
}

// openclaw/src/agents/agent-activity-presentation.ts
function ne(e, n) {
  return n.map((t) => [t, e]);
}
var uf = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ...ne("subagents", ["sessions_spawn"]),
  ...ne("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ...ne("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ...ne("edits", [
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
  ...ne("writes", ["write", "write_file", "create_file"]),
  ...ne("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search"
  ]),
  ...ne("fetches", ["web_fetch", "webfetch", "fetch"])
]);

// openclaw/ui/src/i18n/locales/en-agents.ts
var Yt = {
  menuLabel: "Agent menu",
  agents: "Agents",
  showAll: "Show all",
  createAgent: "Create new agent",
  newAgent: "New agent",
  creatingAgent: "Creating new agent\u2026",
  namedSettings: "{name} settings",
  newConversation: "New session",
  workspaceMenuLabel: "Workspace menu",
  switchAgent: "Switch agent",
  help: "Help",
  getHelp: "Get support",
  getApps: "Get the apps",
  discord: "Discord community",
  viewChangelog: "View changelog"
}, Zt = {
  label: "Agent",
  allAgents: "All agents"
}, Qt = {
  pinToSwitcher: "Pin to switcher",
  unpinFromSwitcher: "Unpin from switcher"
};

// openclaw/ui/src/i18n/locales/en.ts
var ms = {
  runtimeErrors: {
    socketInsecure: "Browser refused the Gateway WebSocket for security reasons. Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789.",
    socketRefused: "Browser refused the Gateway WebSocket for security reasons. Check the Gateway WebSocket URL and browser security policy.",
    socketCreateFailed: "Couldn\u2019t create the Gateway WebSocket. Check the Gateway WebSocket URL and browser security policy. Details: {message}",
    socketTimeout: "gateway websocket opening timed out after {milliseconds}ms"
  },
  pluginUi: {
    retryView: "Retry plugin view",
    inlineLoading: "Loading plugin view\u2026",
    inlineUnavailable: "This view is unavailable. Check that its plugin is installed, enabled, and allowed for your account. Reload the conversation after installing or updating the plugin.",
    dashboardTitle: "Session dashboard",
    customPluginsDisabled: "Custom plugin UI is off",
    customPluginsEnableHint: "Disabled by the Gateway configuration. An administrator can enable native plugin UI.",
    surface: {}
  },
  capacityMeter: {},
  agentsHome: {
    loadFailed: "Couldn\u2019t load agents. Retry."
  },
  outputs: {
    dashboard: "Dashboard"
  },
  common: {
    reportBug: "Report a bug",
    suggestFeature: "Suggest a feature",
    showDetails: "Show details",
    uploadsDisabled: "File and image uploads are disabled.",
    ok: "OK",
    yes: "Yes",
    no: "No",
    active: "Active",
    loading: "Loading\u2026",
    gatewayStarting: "Gateway starting\u2026",
    refreshing: "Refreshing\u2026",
    offline: "Disconnected",
    connect: "Connect",
    connected: "Connected",
    refresh: "Refresh",
    retry: "Retry",
    helpFor: "Help for {section}",
    staleData: "Showing last known data.",
    reload: "Reload",
    reset: "Reset",
    restore: "Restore",
    unarchive: "Unarchive",
    undo: "Undo",
    probe: "Check connection",
    call: "Call",
    dontAskAgain: "Don't ask me again",
    cancel: "Cancel",
    close: "Close",
    previous: "Previous",
    next: "Next",
    continue: "Continue",
    back: "Back",
    create: "Create",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Couldn\u2019t copy. Try again.",
    copyCode: "Copy code",
    copyTable: "Copy table",
    expandTable: "Expand table",
    expandedTable: "Expanded table",
    closeTable: "Close expanded table",
    resizeSplitView: "Resize split view",
    resizeMessageWidth: "Resize message width",
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
    multiSelect: {
      addCustom: "Add \u201C{value}\u201D",
      noMatches: "No matches",
      remove: "Remove {value}"
    },
    loadConfig: "Load config",
    loadApprovals: "Load approvals",
    settingsSections: "Settings sections",
    docs: "Docs",
    learnMore: "Learn more",
    colorMode: "Color mode",
    colorModeOption: "Color mode: {mode}",
    search: "Search",
    clearSearch: "Clear search",
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
  nativeLinkMenu: {},
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
    moreParticipantsLabel: "{count} more participants",
    projectLabel: "Project",
    workspaceLabel: "Workspace",
    branchLabel: "Branch",
    runsOn: "Runs on {providerId} \xB7 {profileId}",
    machineCpu: "{cpu} vCPU",
    machineMemory: "{memory} GB",
    states: {},
    checks: {}
  },
  sessionProgressCard: {
    runtime: {},
    composerTitle: "Task progress",
    clearFailed: "Could not clear saved progress card.",
    refresh: {},
    activity: {},
    outcome: {},
    status: {},
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
    lastError: {},
    refreshingStaleSnapshot: {},
    hub: {},
    pairing: {},
    setup: {},
    config: {},
    generic: {},
    discord: {},
    googleChat: {},
    imessage: {},
    signal: {},
    slack: {},
    telegram: {},
    whatsapp: {
      loggedOut: "Signed out.",
      logoutNotCleared: "No saved WhatsApp session was cleared. It may already be gone or need manual cleanup."
    }
  },
  agentStartup: {
    title: "Starting up",
    description: "The agent is getting ready. This view will load automatically.",
    short: "Starting up\u2026"
  },
  lazyView: {
    errorTitle: "Couldn\u2019t load this panel.",
    genericSubtitle: "Try again.",
    staleTitle: "This view could not load",
    staleSubtitle: "Some interface files could not be downloaded. Check your connection, then reload.",
    bootDraftRecovery: "Copy the draft below before clearing it and reloading.",
    reloading: "Reloading\u2026",
    retry: "Retry",
    stylesFailed: "Styles failed to load, so the page may look broken."
  },
  communityInvite: {
    title: "Pull up a chair.",
    body: "There\u2019s a place for you in the AI future. Join the Community on Reddit, Discord, and X.",
    join: "Join",
    follow: "Follow",
    dismissForever: "Dismiss and don't show again",
    dismissFailed: "Invitation dismissed, but your preference couldn't be saved.",
    joinPlatform: "Join the OpenClaw community on {platform}",
    followPlatform: "Follow OpenClaw on {platform}"
  },
  updates: {
    campaign: {
      countdown: "Updating in {time}",
      waitingForIdle: "Waiting for active work \xB7 forced update in {time}",
      held: "Update held \xB7 resumes in {time}",
      applying: "Applying update\u2026"
    },
    run: {
      phase: {}
    },
    confirm: {},
    target: {
      version: "v{version}",
      commitBehind: "{count} commit behind",
      commitsBehind: "{count} commits behind"
    },
    sidebar: {},
    dialog: {},
    channel: {},
    installKind: {},
    page: {},
    error: "Couldn\u2019t update OpenClaw. {error}",
    checkError: "Couldn\u2019t check for updates. {error}",
    status: "Update {status}: {reason}. {guidance}",
    outcomeUnknown: "Couldn\u2019t confirm the update outcome. Run `openclaw triage` on the computer running OpenClaw and inspect the result before retrying.",
    triage: {
      hostHint: "If Ask OpenClaw is unavailable, run `openclaw triage` on the computer running OpenClaw to open a local coding agent for diagnosis and repair. Diagnose the cause before retrying."
    },
    report: {},
    failureReasons: {
      dirty: "Commit or stash changes, then retry.",
      noUpstream: "Set an upstream branch, then retry.",
      notGitInstall: "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      notOpenclawRoot: "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      depsInstallFailed: "Couldn\u2019t install dependencies. Fix the install error and retry.",
      buildFailed: "Couldn\u2019t build the update. Fix the build error and retry.",
      buildDirty: "The selected revision's build changed checkout files. Retry with a revision that includes its generated artifacts.",
      uiBuildFailed: "Couldn\u2019t rebuild the Control UI. Fix the UI build error and retry.",
      globalInstallFailed: "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      restartDisabled: "The update was not applied because Gateway restarts are disabled. Enable restarts in config, then retry.",
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
      default: "See the Gateway logs for the exact failure and retry once the cause is fixed."
    },
    failedAtStep: "Couldn\u2019t complete {step}: {cause}."
  },
  devices: {
    readOnly: {},
    // The trigger and load failure stay eager; dialog copy follows its lazy renderer.
    pairing: {
      button: "Connect a device",
      adminRequired: "You need admin access to create setup codes.",
      title: "Connect a device",
      loadFailed: "Couldn\u2019t load the connection dialog. Check your connection and try again."
    },
    binding: {},
    inventory: {},
    // Lazy: en-devices.ts registers this subtree when the Devices page renders chips.
    capabilities: {},
    execApprovals: {}
  },
  worktrees: {},
  agentChip: Yt,
  agentScope: Zt,
  newSession: {
    title: "New session",
    hint: "Pick where this session works, then say what to do.",
    placementReloadBlocked: "Recovery needs a reload. Unsaved starts will be lost.",
    discardUnsavedAndReload: "Discard unsaved starts and reload"
  },
  dashboardsPage: {},
  dashboardDocument: {
    close: "Close dashboard",
    missingSession: "No dashboard session was specified.",
    notFound: "This session could not be found.",
    unavailable: "Session dashboards are unavailable for this connection.",
    loadFailed: "Could not load this dashboard: {error}. Check the Gateway connection and try again."
  },
  sessionsView: {
    pullRequestCount: "{count} pull requests",
    subagentPrefix: "Subagent:",
    automationPrefix: "Automation:",
    actionRequiresConnection: "Connect to the Gateway to change sessions.",
    actionUnavailable: "This Gateway does not support this session action.",
    actionRequiresScope: "This action requires {scope} access.",
    actionRequiresOwnership: "Only the session creator or an admin can make this change.",
    draftCleanupFailed: "Session deleted; browser draft remains. Clear site data.",
    createdBy: "Created by {name}",
    ownedBy: "Owned by {name}",
    archivedBy: "Archived by {name}",
    viewingNow: "viewing now",
    owners: "Owners",
    allOwners: "All owners",
    involvingMe: "Involving me",
    withParticipant: "with {name}",
    withMoreParticipants: "+{count} more",
    snoozeWakes: "Wakes {time}",
    snoozeTomorrowTime: "tomorrow {time}",
    snoozeTomorrow: "Tomorrow",
    user: "User",
    assistant: "Assistant",
    approvalNeeded: "Approval needed",
    messageNeedsAttention: "{count} message needs attention",
    messagesNeedAttention: "{count} messages need attention",
    unsentDraft: "Unsent draft",
    noArchivedSessions: "No archived sessions.",
    status: "Status",
    all: "All",
    snoozed: "Snoozed",
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
    runErrorTimedOut: "Timed out",
    runErrorUnknown: "Unknown error",
    attentionRequired: "Session needs attention",
    openSession: "Open session",
    provider: "Provider",
    lastActive: "Last active {time}",
    activeRun: "Active run",
    backgroundWorkRunning: "Background work running",
    subagentsWorking: "Subagents working",
    showChildSessions: "Show {count} child sessions for {session}",
    hideChildSessions: "Hide {count} child sessions for {session}",
    childSessions: "Child sessions",
    showMoreChildren: "Show {count} more",
    archived: "Archived",
    unread: "Unread",
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
    pinSession: "Pin session",
    unpinSession: "Unpin session",
    forkedSession: "Forked session",
    archiveSession: "Archive session",
    restoreSession: "Restore session",
    deleteSessionStale: {},
    deleteSessionIdentityMissing: 'Cannot queue deletion of "{session}" without its session identity. Refresh after reconnecting and try again.',
    deleteSessionsStale: {},
    groupMenu: "Group options for {group}",
    groupOptions: "Group options",
    newSessionInGroup: "New session in {group}",
    groupDefaultsStale: "Gateway connection replaced before the defaults were saved. Try again.",
    moveToTopLevel: "Move to top level"
  },
  agents: {
    noAgents: "No agents yet",
    createdBy: {},
    defaults: {},
    copyId: {},
    default: "Default",
    setDefault: {},
    ...Qt,
    selectTitle: {},
    selectSubtitle: {},
    tabs: {},
    context: {},
    identity: {},
    overview: {
      selectedSkills: "{count} selected",
      allSkills: "All skills",
      modelSelection: {},
      primaryModel: {},
      primaryModelDefault: {},
      notSet: {},
      inheritDefault: {},
      inheritDefaultModel: {},
      fallbacks: {},
      addFallback: {}
    },
    toolCatalog: {},
    skillsPanel: {},
    channels: {},
    cronPanel: {},
    files: {}
  },
  debug: {
    lanes: {},
    overlay: {
      title: "System busyness"
    }
  },
  configForm: {
    hideValue: "Hide value",
    revealValue: "Reveal value",
    defaultValue: "Default: {value}",
    sections: {}
  },
  // Historical namespace from the pre-restructure "quick settings" page; its
  // keys now serve Models, Privacy & Security, Appearance, and Profile.
  // Renaming would force retranslation of every key, so the name stays.
  quickSettings: {
    appearance: {
      lobsterVisits: "Lobster visits"
    },
    personal: {
      browserOnly: "Stored in this browser only."
    }
  },
  configPage: {},
  configView: {
    adminRequired: "You need admin access to change settings.",
    categories: {},
    sections: {},
    themes: {},
    textSizes: {},
    notifications: {},
    appearance: {},
    chatPrefs: {},
    sidebarPrefs: {},
    sessionObserver: {},
    connection: {},
    fileOpenedOnGateway: "Configuration file opened on Gateway host.",
    recoveryNotRestored: "Settings could not be restored. Your draft is kept. Check {path} before saving again.",
    recoveryUnknown: "Settings restoration could not be confirmed. Your draft is kept. Check {path} before saving again.",
    recoveryBackup: "Inspect the recovery backup at {path}.",
    discardUnconfirmed: "The last save could not be confirmed. Your draft is kept. Reload configuration before discarding this setting.",
    writeGatewayChanged: "This unsettled change belongs to a different Gateway. Reconnect to that Gateway to retry, or discard the draft.",
    writeUnconfirmed: "The last configuration change could not be confirmed. Your draft is kept. Retry before changing other settings.",
    reloadBlocked: "Finish saving or discard pending config changes before reloading.",
    rawDraftBlocksApply: "Save or discard edits in the Raw editor before applying changes.",
    rawDraftBlocksFormEdit: "Unsaved raw config edits could not be parsed; resolve them in the Raw editor before changing settings.",
    rawDraftUnverified: "Cannot verify the raw draft against the saved configuration; reload and retry."
  },
  execApproval: {
    scope: {
      standingGrant: 'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
      standingGrantDays: 'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
      messageSend: "Sends to {count} recipient(s) via {target}",
      payment: "Pays {amount} {currency} to {target}",
      externalPost: "Posts externally to {target}"
    },
    reviewOnly: "You need approval access to approve.",
    labels: {}
  },
  approvalPage: {},
  agentTools: {},
  skillGroups: {},
  skillsPage: {},
  skillStatus: {},
  nav: {
    gateway: {
      sectionLabel: "Gateway",
      primaryTag: "primary",
      configReadOnly: "Gateway configuration is read-only.",
      configReadOnlyHint: "To make changes, update the configuration file or deployment settings for this Gateway.",
      setPrimary: "Set as primary\u2026",
      openSettings: "Gateway settings",
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
    settingsGroupSecurity: "Privacy & security",
    settingsGroupSystem: "System",
    settingsSearchLabel: "Search settings",
    settingsSearchPlaceholder: "Search settings\u2026",
    settingsSearchNoResults: "No settings match your search.",
    settingsSearchClear: "Clear settings search",
    settingsLoadFailed: "Settings navigation could not load.",
    exitSettings: "Back to app",
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
    resize: "Resize sidebar",
    pages: "Pages",
    pin: "Pin",
    unpin: "Unpin",
    customize: "Edit pinned items"
  },
  terminal: {
    title: "Terminal",
    toggle: "Toggle terminal",
    open: "Open terminal",
    startCancelled: "Couldn\u2019t start the terminal. Try again.",
    unavailable: "The terminal is unavailable."
  },
  browser: {
    nativeTab: {},
    remoteTab: {},
    stop: {},
    profile: {},
    title: "Browser",
    moreActions: "More actions",
    copyUrl: "Copy URL",
    toggle: "Toggle browser panel",
    close: {},
    resize: {},
    newTab: "New tab",
    closeTab: "Close tab",
    untitledTab: {},
    back: {},
    forward: {},
    reload: {},
    openExternal: "Open in your browser",
    urlPlaceholder: {},
    dockBottom: {},
    dockRight: {},
    annotate: {},
    inspect: {},
    annotateSend: {},
    annotateUndo: {},
    annotateClear: {},
    annotateDone: {},
    annotateHint: {},
    inspectName: {},
    inspectRole: {},
    inspectFocusable: {},
    loading: {},
    notRunning: {},
    start: {},
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
    templates: "Templates",
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
    aiAgents: "Agent defaults",
    modelSetup: "Models",
    memoryImport: "Import memory",
    security: "Privacy & security",
    secrets: "Secrets",
    debug: "Debug",
    logs: "Logs",
    plugin: "Plugin"
  },
  subtitles: {},
  meetingCapture: {
    title: "Meeting capture",
    description: "Choose which sources can save meeting notes on this Gateway.",
    sources: "Auto-start sources"
  },
  cloudWorkersPage: {},
  portalsPage: {},
  modelSetup: {
    discovery: {},
    missingAuth: "No account is available for this model. Add one in Models.",
    commandHint: "Try /models or /help.",
    heading: {},
    intro: {},
    required: {
      title: "No model set up",
      body: "Choose an account or set up a local model to send messages.",
      action: "Set up a model"
    },
    loading: {},
    testing: {},
    retry: {},
    checkAgain: {},
    recovery: {},
    verify: {},
    access: {},
    candidates: {
      title: {},
      recommended: {},
      credentialsReady: {},
      signInNeeded: "Sign-in needed",
      detected: {},
      testAndUse: {},
      retry: {},
      testingButton: {}
    },
    nativeDiscovery: {},
    nativeModels: {},
    empty: {},
    signIn: {},
    prepare: {},
    manual: {},
    success: {},
    utility: {},
    failure: {
      auth: "Authentication failed"
    },
    failureGuidance: {
      auth: "Review the provider credential or sign-in, then retry."
    },
    errors: {},
    wizard: {},
    waitingForApproval: {},
    providerConnected: {}
  },
  memoryImport: {},
  onboarding: {
    memoryImport: {
      title: "Bring your agent memory with you"
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
    dockRight: "Dock assistant sidebar at right"
  },
  custodian: {
    title: {},
    subtitleCaretaker: {},
    exitSetup: {},
    newAgent: "New agent",
    hatchDraft: {},
    placeholder: {},
    sensitivePlaceholder: {},
    sensitiveReply: {},
    cancel: {},
    send: {},
    thinking: {},
    earlier: {},
    requestFailed: {},
    connectionChanged: {},
    sessionRestarted: {},
    unsupportedGateway: {},
    accessRequired: {},
    autoSetup: { thisComputer: "This computer" },
    panel: {},
    history: {},
    nudge: {}
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
    sectionDescription: "Changes save without restarting the Gateway. Code Mode and Tool Search apply to future replies.",
    restartRequired: "Gateway restart required.",
    saveErrorTitle: "Couldn\u2019t save this setting. Try again.",
    saveFailed: "The feature setting could not be saved.",
    decisionAssistance: {},
    usageRankedToolIndex: {},
    codeMode: {},
    swarm: {},
    toolSearch: {},
    hostDesktop: {},
    openclawId: {},
    workerDesktop: {}
  },
  aboutPage: {
    artifactDetails: "Control UI build details",
    commit: "Commit",
    built: "Built",
    unavailable: "Unavailable",
    copyCommit: "Copy full commit hash",
    copiedCommit: "Commit hash copied",
    gateway: "Gateway"
  },
  appsPage: {},
  presence: {
    sharedOwner: {
      name: "Shared owner",
      named: "{name} \xB7 Shared owner",
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
    menu: {
      label: "Actions for {name}",
      pin: "Pin to sidebar",
      unpin: "Unpin from sidebar",
      openNewTab: "Open activity in new tab",
      copyLink: "Copy activity link"
    },
    active: "Active",
    onlineActive: "Online \xB7 Active",
    onlineIdle: "Online \xB7 Idle",
    idle: "Idle",
    offline: "Offline",
    sessions: {
      openCount: "{count}\xA0open",
      runningCount: "{count}\xA0running",
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
      noRecentSessions: "No recent visible sessions.",
      ago: "ago",
      viewActivity: "View activity",
      web: "Web app",
      cli: "Command line",
      terminal: "Terminal",
      app: "App"
    }
  },
  activityFeed: {
    showing: "Showing {shown} of {total}",
    viewingNow: "Viewing now"
  },
  githubPublication: {
    newAction: "Choose a new publication",
    capacity: 'Too many publications are awaiting review. Finish an existing publication, then select "{newAction}" to make room. Existing retries remain available.'
  },
  githubConnections: {
    title: "GitHub accounts",
    mine: "My GitHub",
    system: "Shared agent account"
  },
  profilePage: {
    personalInstructions: {
      title: "Personal instructions",
      description: "Tell this agent about you and how you like to work. This edits only your personal USER.md, not the shared workspace file."
    },
    offline: "Reconnect to view your profile.",
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
      linkedEmails: "Linked emails",
      attribution: "Attribution"
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
  gatewayLogs: {},
  pluginTabs: {
    unavailableTitle: "Plugin panel unavailable",
    unavailableSubtitle: "The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel."
  },
  logbook: {},
  board: {
    announcement: {},
    widget: {
      resizeHandle: "Resize {title}",
      menuLabel: "Widget options",
      moveToTab: "Move to tab",
      noOtherTabs: "No other tabs",
      resize: "Resize",
      autoHeight: "Auto height",
      remove: "Delete"
    }
  },
  connection: {
    browserSignIn: {
      title: "Sign in to continue loading content",
      description: "Your website sign-in has expired. Images and files cannot load until you sign in again. Your conversation and draft will stay open.",
      action: "Sign in",
      dismiss: "Not now",
      returnHint: {},
      checkAgain: {},
      checking: {},
      stillRequired: {},
      unavailable: {}
    },
    connecting: "Connecting\u2026",
    starting: "Starting\u2026",
    restoring: "Restoring\u2026",
    "reload-required": "Refresh required",
    offline: "Disconnected",
    reconnecting: "Reconnecting\u2026",
    interruptedRetrying: "Disconnected. Reconnecting automatically. (WebSocket {code})",
    interrupted: "Disconnected. Check your connection and reconnect. (WebSocket {code})",
    restarting: "Restarting\u2026",
    suspending: "Suspending\u2026",
    suspended: "Suspended",
    retryNow: "Retry now",
    workspace: {
      header: "OpenClaw",
      tryAgain: "Try again",
      reloadAction: "Reload",
      connecting: {
        title: "Connecting to OpenClaw",
        description: "Your workspace opens as soon as the Gateway answers."
      },
      starting: {
        title: "OpenClaw is starting",
        description: "Hang on while the Gateway gets ready."
      },
      restarting: {
        title: "OpenClaw is restarting",
        description: "Back in a moment. Your drafts are safe."
      },
      reconnecting: {
        title: "Still connecting",
        description: "No answer from the Gateway yet. We\u2019ll keep trying."
      },
      pausing: {
        title: "OpenClaw is pausing",
        description: "Finishing what it was doing first."
      },
      paused: {
        title: "OpenClaw is paused",
        description: "Your workspace opens when it resumes."
      },
      restoring: {
        title: "Welcome back",
        description: "Loading your conversations."
      },
      offline: {
        title: "Couldn\u2019t reach the Gateway",
        description: "Check that it\u2019s running, then try again."
      },
      reload: {
        title: "OpenClaw was updated",
        description: "Reload to get the latest version."
      }
    },
    queued: "{count} queued",
    offlineChangesDiscarded: "Offline changes discarded: {count}",
    offlineChangesReloadBlocked: "Offline changes are waiting to reconnect. Reloading would discard them.",
    sessionMoveRefreshFailed: "Couldn\u2019t refresh sessions after the move. The move was saved. Try again. {error}",
    sessionMoveUncertain: "Couldn\u2019t confirm the session move. Refresh and check its group before retrying. {error}",
    sessionOperationCompletedPreviousConnection: "The session operation completed on the previous connection. Check the current session list before continuing.",
    sessionOperationCompletedPreviousConnectionWithRefreshError: "Couldn\u2019t refresh sessions. The operation completed on the previous connection. Try again. {error}",
    scopeUpgrade: {},
    // Settings → Gateway copy lives in the lazy en-settings catalog; the anchor keeps its merge target.
    access: {},
    switchGateway: {},
    help: {
      title: {},
      step1: {},
      step2: {},
      step3: {},
      docsLink: {},
      copyCommand: "Copy command",
      copyCommandAria: "Copy command: {command}"
    }
  },
  // The Inbox loader renders before its diagnostics catalog loads.
  attention: {
    issues: "Inbox"
  },
  standingGrants: {},
  approvalHistory: {},
  commandPalette: {},
  palette: {
    placeholder: "Search or start a task\u2026",
    attachmentPrompt: "What would you like to do with these files?",
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
      badge: "Loading usage\u2026"
    },
    metrics: {
      tokens: "Tokens",
      cost: "Cost"
    },
    heatmap: {
      title: "Token activity",
      subtitle: "Daily token intensity in this range, up to one year.",
      cellTokens: "{tokens} tokens",
      less: "Less",
      more: "More"
    },
    providerUsage: {},
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
      cacheWrite: "Cache write",
      cacheRead: "Cache read",
      total: "Total",
      tokensByType: "Tokens by type",
      costByType: "Cost by type"
    },
    overview: {
      title: "Usage overview"
    },
    sessions: {},
    // Sidebar collapse stays eager; Usage registers the remaining detail copy.
    details: {
      noUsageData: {},
      duration: {},
      modelMix: {},
      filtered: {},
      close: {},
      noTimeline: {},
      loadFailed: {},
      noDataInRange: {},
      usageOverTime: {},
      rangeStart: {},
      rangeEnd: {},
      reset: {},
      perTurn: {},
      cumulative: {},
      turnRange: {},
      assistantOutputTokens: {},
      userToolInputTokens: {},
      tokensWrittenToCache: {},
      tokensReadFromCache: {},
      noContextData: {},
      contextOutOfDate: {},
      systemPromptBreakdown: {},
      collapse: "Collapse",
      collapseAll: {},
      expandAll: {},
      baseContextPerMessage: {},
      system: {},
      systemShort: {},
      skills: {},
      tools: {},
      files: {},
      ofInput: {},
      of: {},
      timelineFiltered: {},
      loadedIntervalMessages: {},
      conversation: {},
      noMessages: {},
      tool: {},
      toolResult: {},
      hasTools: {},
      searchConversation: {},
      filterByRole: {},
      filterByTool: {},
      you: {},
      noMessagesMatch: {}
    },
    mosaic: {}
  },
  // Login copy lives in the lazy en-login catalog; the anchor keeps its merge target.
  login: {},
  chat: {
    sessionAutomation: {},
    activityPills: {},
    mobileDetails: {
      people: "People",
      outputs: "Outputs",
      generatedFiles: "Generated files"
    },
    sessionDetails: {
      automations: "Automations",
      progressOptions: "Task progress options",
      automationError: "Couldn\u2019t load automations. Try again.",
      automationUnavailable: "Automations unavailable.",
      automationLoading: "Loading automations\u2026",
      automationEmpty: "No automations yet.",
      automationMore: "Load more automations",
      automationAttention: "Needs attention",
      automationPaused: "Paused"
    },
    agentDatabaseWarming: "This agent is still starting. Retry in a moment.",
    historyRequestTimedOut: "Couldn\u2019t load the conversation in time. Try again.",
    clawhub: {},
    modelAccounts: {
      section: "Account",
      automatic: "Automatic (new-chat default)",
      manage: "Manage saved accounts\u2026"
    },
    mentions: {},
    cloudWorkerFailed: "Couldn\u2019t continue this session. Check its device and try again. {error}",
    errorDetails: "Error details",
    errorSummary: "Couldn\u2019t complete this action. Try again.",
    errorReplySummary: "Couldn't finish this reply. Check the conversation before trying again.",
    errorReplyTitle: "Couldn\u2019t finish this reply",
    historyUnavailableTitle: "Couldn\u2019t load this conversation",
    historyUnavailableBody: "Try again to load its messages.",
    recovery: {
      retrying: "Retrying\u2026",
      retryingIn: "Retrying in {seconds}s",
      tryingFallback: "Trying fallback model\u2026",
      failedTitle: "Couldn\u2019t finish this reply",
      credentialsRejected: "{provider} didn\u2019t accept the saved credentials",
      billingProblem: "{provider} reports a billing problem",
      openModels: "Open Models",
      failedRepeatCount: "{count} times",
      tryAgain: "Try again",
      continuePrompt: "Continue from where you stopped. Check which actions already completed before retrying anything."
    },
    errorBusySummary: "OpenClaw is busy. Check status before trying again.",
    errorSignInSummary: "Couldn't sign in to the AI service. Sign in again under Models.",
    errorStartSummary: "Couldn\u2019t start this session. Try again.",
    checkStatus: "Check status",
    details: "Details",
    usageLimit: {},
    copyError: "Copy error",
    providerAccessRemoved: "This reply stopped because the provider was signed out. Sign in again or choose another model.",
    providerReview: {},
    providerPolicy: {},
    diskSpace: {},
    workerRuntimeInstall: {},
    sendErrors: {},
    waitingForApproval: "Waiting for approval\u2026",
    waitingOnSubagents: "Waiting on subagents",
    waitingForMessage: "Waiting for a message",
    waitingOnSubagent: "Waiting on {name}",
    waitingOnSessions: "Waiting on {count} sessions",
    sessionsNeedInputOne: "1 needs your input",
    sessionsNeedInput: "{count} need your input",
    sessionsPaused: "{count} paused",
    sessionPausedNote: "{name} is paused",
    sessionsPausedNote: "{count} sessions are paused",
    handoffResumed: "Resumed \xB7 {duration} later",
    handoffSessionsOne: "1 session",
    handoffSessions: "{count} sessions",
    handoffSessionStatus: {
      attention: "Needs your input",
      paused: "Paused",
      running: "Running",
      failed: "Failed",
      stopped: "Stopped",
      done: "Done"
    },
    subagentsRunning: "{count} subagents running",
    subagentsRunningOne: "1 subagent running",
    startupStatus: {
      preparingWorkspace: "Preparing workspace\u2026",
      namingWorktree: "Naming worktree\u2026",
      updatingRepository: "Updating repository\u2026",
      creatingWorktree: "Creating worktree\u2026",
      runningSetup: "Running setup\u2026",
      provisioningEnvironment: "Provisioning environment\u2026",
      startingFromSnapshot: "Starting from snapshot\u2026",
      preparingCloudEnvironment: "Preparing cloud environment\u2026",
      savingSnapshot: "Saving snapshot\u2026",
      preparingContext: "Preparing reply\u2026",
      memoryFlushing: "Saving conversation memory\u2026",
      startingModel: "Waiting for a response",
      waitingForLocalModel: "Waiting for the local model to respond",
      waitingForModelSlot: "Waiting for a free model slot",
      waitingForState: "Temporarily busy\u2014retrying\u2026"
    },
    archivedSessionDisabled: "This session is archived. Unarchive it to continue the conversation.",
    subagentViewOnly: "View-only subagent",
    subagentSessionDisabled: "Continue in {parent}.",
    processesPanel: { title: "Processes" },
    subagentsPanel: {},
    parentSession: "the parent session",
    openParentSession: "Open parent session",
    parentSessionUnavailable: "Parent session information is unavailable.",
    sessionRoute: {},
    commandResults: {
      emptyExport: "No messages to export yet.",
      exportPathUnsupported: "Control UI exports Markdown through your browser. Run /export without a file path.",
      help: {},
      compaction: {},
      model: {},
      thinking: {},
      verbose: {},
      fast: {
        autoValue: "auto ({seconds} sec)",
        on: "on",
        off: "off",
        sourceSession: " (session)",
        sourceAgent: " (default: agent)",
        sourceModel: " (default: model)",
        sourceDefault: " (default)",
        current: "Current fast mode: {value}"
      },
      usage: {},
      agents: {},
      steer: {},
      redirect: {}
    },
    sessionSharing: {
      draft: "Draft"
    },
    reactions: {},
    sessionSuggestions: {
      state: {}
    },
    sessionHeader: {},
    board: {},
    codexSupervisionDisabled: "Codex supervision is off. Enable it in plugin settings to continue this session.",
    openCodexSettings: "Open settings",
    catalog: {},
    taskSuggestions: {},
    pullRequests: {
      open: "Open",
      draft: "Draft",
      merged: "Merged",
      closed: "Closed"
    },
    usageRemaining: "Usage remaining",
    view: {},
    sendShortcutModifierEnter: "\u2318/Ctrl+Enter",
    followUpModeSteer: "Steer this reply",
    catalogOutputTruncated: "[Output truncated]",
    onboardingDisabled: "Disabled during setup",
    commandPaletteTitle: "Search or jump to\u2026 (\u2318K)",
    openCommandPalette: "Search",
    actions: {
      copyAsMarkdown: "Copy as markdown",
      dismissError: "Dismiss error",
      scrollToLatest: "Scroll to latest",
      skipToComposer: "Skip to message composer"
    },
    markdown: {
      truncated: "\u2026 truncated ({total} chars, showing first {shown})."
    },
    mermaid: {},
    codeBlock: {},
    workspaceConflict: {},
    compaction: {
      savedTokensWithPercent: "saved {count} tokens ({percent}%)"
    },
    sessionReset: {
      label: "Session reset",
      description: "The earlier conversation was cleared."
    },
    outboxRecoveryReviewTitle: {},
    outboxRecoveryConfirm: {},
    outboxRecoveryRestore: {},
    outboxRecoveryConflict: {},
    outboxRecoveryStorageFailed: {},
    outboxRecoveryFull: {},
    outboxRecoveryDraft: {},
    outboxRecoveryQueued: {},
    outboxRecoverySource: {},
    outboxRecoveryUpdated: {},
    outboxRecoveryGoal: {},
    outboxRecoveryReply: {},
    outboxRecoveryAttachments: {},
    outboxRecoveryUnconfirmedLabel: {},
    outboxRecoveryUnconfirmed: {},
    outboxRecoveryAttachmentMissing: {},
    outboxRecoveryDelete: {},
    outboxRecoveryDeleteTitle: {},
    outboxRecoveryDeleteConfirm: {},
    outboxRecoveryDeleteConflict: {},
    privateDraftReload: {
      blocked: "An unsent Incognito draft is keeping this tab open. Review it before refreshing.",
      review: "Review private draft",
      changed: "The draft changed while you were reviewing it. It has not been discarded; review the current draft before refreshing.",
      unavailable: "The private draft could not be opened. It remains in this tab; try Review private draft again."
    },
    incognitoExpiredTitle: "Incognito session expired",
    incognitoExpiredBody: "Incognito sessions last for 24 hours or until the Gateway restarts. Your unsent input stays in this tab.",
    newIncognitoSession: "New Incognito session",
    systemNotice: {
      guardian: {},
      automationRecovery: {},
      gatewayRestarted: {},
      cliHarnessContext: {},
      claudeCliTaskNotification: {}
    },
    skillLearned: {},
    progressLabels: {},
    turnRecap: {
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
      chooseConversation: "Choose a session",
      missingOwner: "Select this pane, then choose Home or a session in the sidebar to restore it.",
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
      threads: "Sessions",
      pinned: "Pinned",
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
      catalogGroupByProject: "Project",
      catalogGroupByPerson: "Person",
      openSessionMenu: "Open session menu",
      sortBy: "Sort by",
      sortCreated: "Created",
      menuFilters: "Filters",
      menuDisplay: "Display",
      sortSessions: "Filter & sort",
      sessionSources: "Session sources",
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
      queue: "Queue",
      queueMessage: "Queue message",
      stop: "Stop",
      stopWithShortcut: "Stop (Esc)",
      stopGenerating: "Stop generating",
      send: "Send",
      sendMessage: "Send message"
    },
    queue: {},
    goals: {},
    asyncQuestions: {},
    questions: {
      showSecret: "Show secret",
      hideSecret: "Hide secret",
      answer: "Answer",
      disconnected: "Reconnect to try again."
    },
    imageLightbox: {},
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
      errorSender: "Error",
      agentName: "Agent"
    },
    mediaPlayer: {},
    youtube: {},
    modelControls: {},
    nativeRuntimeRecovery: {},
    permissionControls: {},
    rail: {},
    detailPanel: {},
    sidebarColumns: {
      close: "Close {panel}"
    },
    sidePanel: {
      context: "Context",
      contextEmpty: "Send a message to capture context usage.",
      label: "Side panel",
      quickAccess: "Quick access",
      explorePanels: "Explore panels",
      addTab: "Add side panel tab",
      closeNewTab: "Close New tab",
      closeAllTabs: "Close all tabs",
      closeOtherTabs: "Close other tabs",
      closeFileChanges: "Save changes to {file} before closing?",
      expand: "Focus",
      expandPanel: "Expand {panel}",
      restore: "Restore split",
      useViewAsDefault: "Use current view as default",
      currentViewIsDefault: "This is the default view",
      defaultViewDescription: "Used when anyone opens this dashboard. Personal layout choices still apply.",
      savingDefault: "Saving default\u2026",
      defaultSaved: "Dashboard default saved for future opens.",
      defaultSaveFailed: "Couldn\u2019t save the dashboard default. Check the connection and try again.",
      defaultSaveError: "Couldn\u2019t save the dashboard default. Try again.",
      swap: "Swap {main} and {side}",
      panelPosition: "Panel position",
      dockLeft: "Move side panel left",
      dockRight: "Move side panel right",
      dockBottom: "Move side panel below",
      positionLeft: "Left",
      positionRight: "Right",
      positionBelow: "Below",
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
      browserUnavailableReason: {
        permission: "You need admin access to use Browser.",
        disconnected: "Disconnected.",
        unavailable: "Browser unavailable."
      },
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
      dashboardOptions: "Dashboard options",
      dashboardSize: "Size",
      dashboardEmpty: "This task does not have a dashboard yet."
    },
    thread: {},
    pendingInputs: {
      agentUpdate: {}
    },
    pairingQrExpired: {
      title: "Pairing code expired",
      reason: "Run /pair qr again to get a new setup code.",
      badge: "Expired"
    },
    composer: {},
    attachments: {
      previewUnavailable: "Preview unavailable"
    },
    voice: {},
    selectors: {
      loadMoreSessions: "Show more",
      loadMoreRosterSessions: "Load more sessions",
      model: "Chat model",
      modelSection: "Model",
      modelLocked: "Locked",
      modelLockedLabel: "Model selection controlled for this session",
      lockedSessionModel: "Session model",
      thinkingLevel: "Effort"
    },
    permissions: {},
    toolCards: {
      tool: "Tool",
      activity: {},
      review: {},
      verbs: {}
    },
    workRun: {
      workedFor: "Worked for {duration}",
      worked: "Worked",
      toolCallsOne: "1 tool call",
      toolCallsMany: "{count} tool calls"
    },
    sessionDiff: {
      title: "Changes",
      show: "Show session changes"
    },
    sessionDiscussion: {},
    workspaceFiles: {
      copyPath: "Copy path"
    }
  },
  languages: {},
  // Navigation and in-chat secret requests render before the Secrets page loads.
  secretsStore: {
    allowedHosts: "Allowed hosts",
    allowedHostsPlaceholder: "api.example.com",
    protectedSecret: "Protected secret",
    agentReadable: "Agent-readable environment",
    hint: "Choose protected, write-only secrets or intentionally agent-readable Gateway environment values."
  },
  cron: {
    adminRequired: {},
    tabs: {},
    list: {},
    suggestions: {},
    stats: {},
    detail: {},
    actions: {},
    runNotStarted: {},
    jobs: {},
    runs: {},
    form: {},
    jobState: {},
    runEntry: {},
    errors: {}
  },
  linkReader: {
    loadingPreview: "Loading preview\u2026",
    title: "Link reader",
    urlPlaceholder: "Supported link URL"
  },
  openclawId: {}
}, se = ms;

// openclaw/ui/src/i18n/locales/en-chat-tool-labels.ts
var er = {
  chat: {
    toolCards: {
      patch: {
        move: "Move {source} \u2192 {path}",
        add: "Add {path}",
        delete: "Delete {path}",
        update: "Update {path}"
      },
      summary: "Summary",
      toolInput: "Tool input",
      toolOutput: "Tool output",
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
      openFile: "Open file",
      copyToClipboard: "Copy to clipboard",
      downloadFile: "Download file",
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
      noOutputSucceeded: "No output \u2014 tool completed.",
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
    }
  }
}, nr = Object.assign(
  () => {
    let { activity: e, review: n, verbs: t, ...o } = er.chat.toolCards;
    Object.assign(se.chat.toolCards, o), Object.assign(se.chat.toolCards.activity, e), Object.assign(se.chat.toolCards.review, n), Object.assign(se.chat.toolCards.verbs, t);
  },
  { catalog: er }
);

// openclaw/ui/src/lib/protocol-validators.generated/activity.js
function te(e) {
  let n = 0, t = 0, o = 0;
  for (; t < e.length; ) {
    let r = e.charCodeAt(t++) >> 10;
    n += +((o << 8 | r) !== 13879), o = r;
  }
  return n;
}
var ir = [
  /(^delegation$|^itemId$|^phase$|^kind$|^title$|^status$|^name$|^meta$|^commandBearing$|^toolCallId$|^unpairedCall$|^startedAt$|^endedAt$|^error$|^summary$|^progressText$|^suppressChannelProgress$|^hideFromChannelProgress$|^approvalId$|^approvalSlug$)/u,
  /(^runId$|^childSessionKey$|^label$|^groupId$|^runtimeMs$|^status$)/u,
  /(^sessionKey$|^agentId$|^sessionId$|^lifecycleRevision$|^runId$|^revision$|^updatedAt$|^headline$|^assessment$|^health$|^planProgress$)/u,
  /(^completed$|^total$)/u,
  /(^sessionKey$|^agentId$|^runId$|^text$)/u,
  /(^sessionKey$|^agentId$|^sessionId$|^messageId$|^emoji$|^action$|^actor$|^reactions$)/u,
  /(^type$|^id$|^label$|^avatarUrl$|^identity$)/u,
  /(^type$|^id$)/u,
  /(^type$|^id$)/u,
  /(^type$|^pluginId$|^domain$|^idKind$|^id$)/u,
  /(^type$|^pluginId$|^accountId$|^senderKind$|^id$)/u,
  /(^type$|^actorType$|^source$|^id$)/u,
  /(^emoji$|^count$|^identities$)/u,
  /(^id$|^label$)/u
], ys = (e) => bs(e), bs = (e) => typeof e == "object" && e !== null && !Array.isArray(e) && "itemId" in e && "phase" in e && "kind" in e && "title" in e && Object.getOwnPropertyNames(e).every(
  (n, t) => ir[0].test(n) || sr(e[n])
) && (e.delegation === void 0 || !("delegation" in e) || xs(e.delegation)) && Es(e.itemId) && vs(e.phase) && rr(e.kind) && rr(e.title) && (e.status === void 0 || !("status" in e) || Os(e.status)) && (e.name === void 0 || !("name" in e) || X(e.name)) && (e.meta === void 0 || !("meta" in e) || X(e.meta)) && (e.commandBearing === void 0 || !("commandBearing" in e) || Oe(e.commandBearing)) && (e.toolCallId === void 0 || !("toolCallId" in e) || X(e.toolCallId)) && (e.unpairedCall === void 0 || !("unpairedCall" in e) || Oe(e.unpairedCall)) && (e.startedAt === void 0 || !("startedAt" in e) || or(e.startedAt)) && (e.endedAt === void 0 || !("endedAt" in e) || or(e.endedAt)) && (e.error === void 0 || !("error" in e) || X(e.error)) && (e.summary === void 0 || !("summary" in e) || X(e.summary)) && (e.progressText === void 0 || !("progressText" in e) || X(e.progressText)) && (e.suppressChannelProgress === void 0 || !("suppressChannelProgress" in e) || Oe(e.suppressChannelProgress)) && (e.hideFromChannelProgress === void 0 || !("hideFromChannelProgress" in e) || Oe(e.hideFromChannelProgress)) && (e.approvalId === void 0 || !("approvalId" in e) || X(e.approvalId)) && (e.approvalSlug === void 0 || !("approvalSlug" in e) || X(e.approvalSlug)), sr = (e) => !1, xs = (e) => Array.isArray(e) && e.every((n, t) => ws(n)) && e.length <= 32, ws = (e) => typeof e == "object" && e !== null && !Array.isArray(e) && "runId" in e && "childSessionKey" in e && "status" in e && Object.getOwnPropertyNames(e).every(
  (n, t) => ir[1].test(n) || sr(e[n])
) && ks(e.runId) && Cs(e.childSessionKey) && (e.label === void 0 || !("label" in e) || tr(e.label)) && (e.groupId === void 0 || !("groupId" in e) || tr(e.groupId)) && (e.runtimeMs === void 0 || !("runtimeMs" in e) || Rs(e.runtimeMs)) && _s(e.status), ks = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && te(e) >= 1) && (e.length <= 256 || e.length <= 512 && te(e) <= 256), Cs = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && te(e) >= 1) && (e.length <= 1024 || e.length <= 2048 && te(e) <= 1024), tr = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && te(e) >= 1) && (e.length <= 512 || e.length <= 1024 && te(e) <= 512), Rs = (e) => Number.isFinite(e) && e >= 0 && e <= 9007199254740991, _s = (e) => Ts(e) || Is(e) || ar(e) || Ss(e) || As(e), Ts = (e) => typeof e == "string" && e === "accepted", Is = (e) => typeof e == "string" && e === "done", ar = (e) => typeof e == "string" && e === "failed", Ss = (e) => typeof e == "string" && e === "killed", As = (e) => typeof e == "string" && e === "timeout", Es = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && te(e) >= 1), vs = (e) => Ms(e) || Ds(e) || Ps(e), Ms = (e) => typeof e == "string" && e === "start", Ds = (e) => typeof e == "string" && e === "update", Ps = (e) => typeof e == "string" && e === "end", rr = (e) => typeof e == "string", Os = (e) => Fs(e) || Ns(e) || ar(e) || Ls(e) || Bs(e), Fs = (e) => typeof e == "string" && e === "running", Ns = (e) => typeof e == "string" && e === "completed", Ls = (e) => typeof e == "string" && e === "blocked", Bs = (e) => typeof e == "string" && e === "skipped", X = (e) => typeof e == "string", Oe = (e) => typeof e == "boolean", or = (e) => Number.isFinite(e);
var ur = (e) => ys(e);

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
nr();
function cr(e) {
  let n = P(e)?.activity;
  return Array.isArray(n) ? n.filter(ur) : [];
}

// openclaw/ui/src/lib/chat/tool-live-output.ts
function lr(e) {
  return z(e) && typeof e.text == "string" && typeof e.omittedChars == "number" && Number.isSafeInteger(e.omittedChars) && e.omittedChars >= 0 ? { text: e.text, omittedChars: e.omittedChars } : void 0;
}

// openclaw/ui/src/lib/chat/tool-cards.ts
function Us(e) {
  return S(e.messageId) ?? S(N(e.__openclaw)?.id);
}
function dr(e) {
  let n = N(N(e)?.__openclaw), t = N(n?.toolOutput);
  return (t?.source === "provider-response" || t?.source === "execution") && t.modelInput === "unverified" ? {
    source: t.source,
    modelInput: t.modelInput,
    ...t.outcome === "unknown" ? { outcome: "unknown" } : {},
    ...t.captureTruncated === !0 ? { captureTruncated: !0 } : {}
  } : void 0;
}
function js(e) {
  return Array.isArray(e) ? e.filter((n) => V(n) !== null) : [];
}
function zs(e) {
  if (typeof e != "string")
    return e;
  let n = e.trim();
  return n.startsWith("{") || n.startsWith("[") ? Ue(n) ?? e : e;
}
function $s(e) {
  if (typeof e.text == "string")
    return e.text;
  if (typeof e.content == "string")
    return e.content;
  if (Array.isArray(e.content)) {
    let n = e.content.flatMap((t) => {
      let o = V(t)?.text;
      return typeof o == "string" ? [o] : [];
    });
    if (n.length > 0)
      return n.join(`
`);
  }
}
function Ws(...e) {
  for (let n of e) {
    let t = V(n), o = t?.exitCode ?? t?.exit_code;
    if (typeof o == "number" && Number.isInteger(o))
      return o;
  }
}
function hr(e) {
  if (e.activity)
    return e.activity.status === "skipped";
  let n = V(e.details);
  return (e.live !== !0 || e.completed === !0) && n?.status === "skipped" && n.deniedReason === "steering";
}
function pr(e) {
  if (hr(e))
    return !1;
  if (e.activity)
    return e.activity.status === "failed";
  let n = e.live !== !0 || e.completed === !0;
  return e.isError ?? (n && vn(e.outputText));
}
function mr(e, n) {
  if (hr(e))
    return "skipped";
  if (e.toolOutput?.outcome === "unknown")
    return pr(e) ? "failed" : "unknown";
  if (e.activity?.unpairedCall)
    return n === !0 && e.live === !0 && e.completed !== !0 ? "running" : "unrecorded";
  if (e.activity) {
    let { status: t, phase: o } = e.activity;
    return t === "failed" || t === "blocked" ? t : t === "completed" ? "succeeded" : n === !0 && e.live === !0 && (t === "running" || o !== "end" && e.completed !== !0) ? "running" : "unknown";
  }
  return pr(e) ? "failed" : n === !0 && e.live === !0 && e.completed !== !0 ? "running" : e.completed === !0 || e.live !== !0 && e.outputText !== void 0 ? "succeeded" : "unrecorded";
}
function qs(e) {
  let n = Sn(e);
  return n?.surface === "assistant_message" ? { ...n, surface: "assistant_message" } : void 0;
}
function Gs(e, n) {
  let t = In(e);
  return t?.surface === "assistant_message" ? { ...t, surface: "assistant_message" } : qs(n);
}
function Js(e, n, t) {
  let o = Gs(e, n);
  if (o)
    return { preview: o };
  let r = N(N(e)?.browserTab), i = mn(r);
  return t !== "browser" || !r || !i ? {} : { browserTab: i };
}
function fr(e, n) {
  return En(e) ?? B(e.callId) ?? B(n.toolCallId) ?? B(n.tool_call_id) ?? B(n.toolUseId) ?? B(n.tool_use_id);
}
function pn(e, n) {
  return B(e.name) ?? B(n.toolName) ?? B(n.tool_name) ?? "tool";
}
function Ks(e) {
  if (e != null)
    return typeof e == "string" ? e : JSON.stringify(e, null, 2);
}
var Hs = 0;
function Xs(e) {
  return je(e.type) || typeof e.name == "string" && (e.arguments != null || e.args != null || e.input != null);
}
function gr(e) {
  let n = e, t = N(n.__openclaw), o = t?.catalogSource === !0, r = typeof n.role == "string" ? n.role.toLowerCase() : "", i = dn(e) || r === "tool" || r === "function" || typeof n.toolName == "string" || typeof n.tool_name == "string", s = js(n.content), a = ke(n), l = n.__openclawToolStreamLive === !0, d = l ? lr(n.__openclawToolStreamLiveOutput) : void 0, h = Vt(n.__openclawToolStreamDiffStat), f = [], y = /* @__PURE__ */ new WeakSet(), u = Us(n), c = Be(n)?.runId ?? S(n.runId), m = (g, x, w = !1) => {
    let k = $s(g), C = g.details ?? n.details, _ = N(g.__openclaw), A = ke(g) ?? a ?? (o ? !1 : void 0), T = Ws(
      g,
      C,
      !o && k ? Z(k.trim()) : void 0,
      w ? void 0 : n
    );
    return {
      outputText: k,
      ...o && _?.catalogTruncated === !0 ? { catalogTruncated: !0 } : {},
      resultMessageId: o ? void 0 : !w && _ && Object.hasOwn(_, "id") ? S(_.id) : u,
      outputTruncated: (_ && Object.hasOwn(_, "truncated") ? _ : N(n.__openclaw))?.truncated === !0,
      toolOutput: dr(g) ?? dr(n),
      ...C !== void 0 ? { details: C } : {},
      ...A !== void 0 ? { isError: A } : {},
      ...T !== void 0 ? { exitCode: T } : {},
      ...o ? {} : Js(C, k, x)
    };
  };
  for (let g = 0; g < s.length; g++) {
    let x = s[g] ?? {}, w = Xs(x);
    if (!w && !we(x.type))
      continue;
    let k = S(x.runId) ?? c, C = S(x.parentToolCallId), _ = fr(x, n), A = pn(x, n), T = {
      id: _ ?? `${A}:${g}`,
      ..._ ? { callId: _ } : {},
      ...k ? { runId: k } : {},
      ...C ? { parentToolCallId: C } : {},
      name: A,
      messageId: u
    }, M = x.details ?? n.details;
    if (w) {
      let v = zs(x.arguments ?? x.args ?? x.input);
      f.push({
        ...T,
        args: v,
        inputText: Ks(v),
        ...M !== void 0 ? { details: M } : {},
        ...l ? {
          live: !0,
          completed: n.__openclawToolStreamResultReceived === !0 || n.__openclawToolStreamItemEnded === !0
        } : {},
        ...h ? { liveDiffStat: h } : {},
        ...d ? { liveOutput: d } : {}
      });
      continue;
    }
    let I = f.find((v) => v.id === T.id) ?? f.find(
      (v) => (
        // Same-name fallback belongs to legacy blocks missing an explicit identity.
        (!_ || !v.callId) && v.name === A && v.outputText === void 0 && !y.has(v)
      )
    ), D = i ? pn({}, n) : void 0, j = D && D !== "browser" ? D : I?.name ?? D ?? A, L = m(x, j);
    if (I) {
      y.add(I), I.callId ??= _, I.runId ??= k, I.parentToolCallId ??= C, l || (I.completed = !0), Object.assign(I, L, {
        preview: L.preview,
        browserTab: L.browserTab
      });
      continue;
    }
    f.push({
      ...T,
      completed: !0,
      ...L
    });
  }
  if (i && f.length === 0) {
    let g = typeof n.toolName == "string" && n.toolName || typeof n.tool_name == "string" && n.tool_name || "tool", x = fr({}, n);
    f.push({
      id: x ?? `${pn({}, n)}:0`,
      ...x ? { callId: x } : {},
      ...c ? { runId: c } : {},
      name: g,
      completed: dn(e) || r === "tool" || r === "function",
      messageId: u,
      ...m(n, g, !0)
    });
  }
  let p = new Map(
    cr(e).filter((g) => !g.suppressChannelProgress).map((g) => [g.toolCallId ?? g.itemId, g])
  ), b;
  for (let [g, x] of f.entries()) {
    o && t?.catalogTruncated === !0 && (x.catalogTruncated = !0);
    let w = x.callId ? p.get(x.callId) : void 0;
    w && (x.activity = w), !(!x.browserTab || x.callId || x.messageId) && (b ??= ++Hs, x.previewRevision = `${b}:${g}`);
  }
  return f;
}
function yr(e) {
  if (!e || typeof e != "object")
    return gr(e);
  let n = ze(e), t = n.toolCards;
  if (t)
    return t;
  let o = gr(e);
  return n.toolCards = o, o;
}

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
function Vs(e) {
  return e.callId ?? e.messageId ?? e.previewRevision;
}
var br = /* @__PURE__ */ new WeakMap(), Ys = /* @__PURE__ */ new Map();
function xr(e, n) {
  let t = br.get(e);
  if (t?.toolMessages === n)
    return t.latest;
  let o;
  for (let i of [e, n])
    for (let s of i)
      if (z(s))
        for (let a of yr(s)) {
          let l = Vs(a);
          if (a.browserTab && l && mr(a, !1) === "succeeded") {
            let d = yn(a.browserTab);
            o ??= /* @__PURE__ */ new Map(), o.delete(d), o.set(d, { tab: a.browserTab, revision: l });
          }
        }
  let r = o ?? Ys;
  return br.set(e, { toolMessages: n, latest: r }), r;
}

// octogee/app/openclaw-browser/resources.ts
function Kf(e, n) {
  return [...xr(e, []).values()].filter((o) => o.tab.target === "host" && o.tab.profile === n).at(-1) ?? null;
}
export {
  Kf as latestNativeBrowserTab
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

markdown-it/dist/markdown-it.mjs:
  (*! markdown-it 15.0.3 https://github.com/markdown-it/markdown-it @license MIT *)
*/
