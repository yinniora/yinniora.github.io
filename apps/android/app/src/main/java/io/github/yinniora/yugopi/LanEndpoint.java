package io.github.yinniora.yugopi;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

record LanEndpoint(URI url, InetAddress ip, byte[] fingerprint) {
    private static final Pattern URL = Pattern.compile(
            "wss://(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2}):([1-9]\\d{0,4})/remote-signal");
    private static final Pattern PIN = Pattern.compile("(?:[0-9a-f]{2}:){31}[0-9a-f]{2}");

    static LanEndpoint parse(String url, String pin) {
        if (url.length() > 80 || pin.length() != 95 || !PIN.matcher(pin).matches()) return null;
        Matcher values = URL.matcher(url);
        if (!values.matches() || Integer.parseInt(values.group(5)) > 65535) return null;
        byte[] octets = new byte[4];
        for (int i = 0; i < octets.length; i++) {
            int octet = Integer.parseInt(values.group(i + 1));
            if (octet > 255) return null;
            octets[i] = (byte) octet;
        }
        int first = Byte.toUnsignedInt(octets[0]);
        int second = Byte.toUnsignedInt(octets[1]);
        if (first != 10 && (first != 172 || second < 16 || second > 31) && (first != 192 || second != 168)) {
            return null;
        }
        byte[] digest = new byte[32];
        for (int i = 0; i < digest.length; i++) {
            digest[i] = (byte) Integer.parseInt(pin.substring(i * 3, i * 3 + 2), 16);
        }
        try {
            return new LanEndpoint(URI.create(url), InetAddress.getByAddress(octets), digest);
        } catch (UnknownHostException invalid) {
            return null;
        }
    }

    SSLContext tls() throws GeneralSecurityException {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("LAN signals do not use client certificates");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("Missing LAN certificate");
                try {
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                    if (MessageDigest.isEqual(digest, fingerprint)) return;
                } catch (GeneralSecurityException error) {
                    throw new CertificateException("Could not verify LAN certificate", error);
                }
                throw new CertificateException("LAN certificate does not match the pairing code");
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }}, null);
        return context;
    }
}
