package io.github.yinniora.yugopi;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class LanEndpointTest {
    private static final String URL = "wss://192.168.0.14:43124/remote-signal";
    private static final String PIN = "ab:".repeat(31) + "ab";
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void acceptsCanonicalPrivateIPv4AndExplicitPort() {
        for (String address : new String[] {"10.0.0.1", "172.16.0.1", "172.31.0.1", "192.168.0.1"}) {
            LanEndpoint endpoint = LanEndpoint.parse("wss://" + address + ":443/remote-signal", PIN);
            assertNotNull(endpoint);
            assertEquals(address, endpoint.ip().getHostAddress());
            assertEquals(443, endpoint.url().getPort());
        }
    }

    @Test public void rejectsAlternateHostsPathsPortsAndPins() {
        for (String endpoint : new String[] {
                "wss://127.0.0.1:43124/remote-signal", "wss://100.100.0.1:43124/remote-signal",
                "wss://172.32.0.1:43124/remote-signal", "wss://192.168.001.1:43124/remote-signal",
                "wss://192.168.0.256:43124/remote-signal", "wss://192.168.0.1:65536/remote-signal",
                "wss://[fd00::1]:43124/remote-signal", "wss://host.local:43124/remote-signal",
                "ws://192.168.0.1:43124/remote-signal", "wss://192.168.0.1/remote-signal",
                "wss://user@192.168.0.1:43124/remote-signal", "wss://192.168.0.1:43124/remote-signal?",
                "wss://192.168.0.1:43124/remote-signal#pin", "wss://192.168.0.1:43124/%72emote-signal",
                "wss://192.168.0.1:43124/api/version", URL + "\n",
        }) assertNull(endpoint, LanEndpoint.parse(endpoint, PIN));
        for (String pin : new String[] {"", PIN + ":ab", PIN.replace(":", ""), PIN.toUpperCase(), PIN + "\n"}) {
            assertNull(LanEndpoint.parse(URL, pin));
        }
    }

    @Test(timeout = 20000) public void matchesTheExactSelfSignedLeafInATlsHandshake() throws Exception {
        Path file = temporary.getRoot().toPath().resolve("host.p12");
        String password = "fixture-password";
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        String keytool = Path.of(System.getProperty("java.home"), "bin", windows ? "keytool.exe" : "keytool").toString();
        Process generator = new ProcessBuilder(keytool, "-genkeypair", "-noprompt", "-alias", "fixture",
                "-keyalg", "EC", "-dname", "CN=Local LAN Test", "-keystore", file.toString(),
                "-storetype", "PKCS12", "-storepass", password, "-validity", "1").redirectErrorStream(true).start();
        assertTrue(generator.waitFor(10, TimeUnit.SECONDS));
        assertEquals(new String(generator.getInputStream().readAllBytes()), 0, generator.exitValue());
        KeyStore key = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(file)) { key.load(input, password.toCharArray()); }
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(key, password.toCharArray());
        SSLContext server = SSLContext.getInstance("TLS");
        server.init(managers.getKeyManagers(), null, null);
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(key.getCertificate("fixture").getEncoded());
        StringBuilder pin = new StringBuilder();
        for (byte value : hash) {
            if (pin.length() != 0) pin.append(':');
            pin.append(String.format("%02x", value));
        }
        verifyHandshake(server, LanEndpoint.parse(URL, pin.toString()).tls(), true);
        pin.setCharAt(0, pin.charAt(0) == '0' ? '1' : '0');
        verifyHandshake(server, LanEndpoint.parse(URL, pin.toString()).tls(), false);
    }

    private static void verifyHandshake(SSLContext host, SSLContext client, boolean trusted) throws Exception {
        InetAddress address = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        try (SSLServerSocket server = (SSLServerSocket) host.getServerSocketFactory().createServerSocket(0, 1, address)) {
            server.setSoTimeout(4000);
            FutureTask<Boolean> peer = new FutureTask<>(() -> {
                try (SSLSocket accepted = (SSLSocket) server.accept()) {
                    accepted.setSoTimeout(4000);
                    accepted.startHandshake();
                    accepted.getOutputStream().write(1);
                    return true;
                } catch (IOException denied) {
                    if (trusted) throw denied;
                    return false;
                }
            });
            Thread thread = new Thread(peer);
            thread.setDaemon(true);
            thread.start();
            try (SSLSocket socket = (SSLSocket) client.getSocketFactory().createSocket(address, server.getLocalPort())) {
                socket.setSoTimeout(4000);
                socket.startHandshake();
                if (!trusted) fail("a different certificate must fail the handshake");
                assertEquals(1, socket.getInputStream().read());
            } catch (SSLHandshakeException denied) {
                if (trusted) throw denied;
            }
            assertEquals(trusted, peer.get(5, TimeUnit.SECONDS));
        }
    }
}
