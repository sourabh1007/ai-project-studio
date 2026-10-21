package com.sourabh1007.aiprojectstudio.preview;

import static org.junit.Assert.*;
import org.junit.Test;

public final class HostOriginTest {
    @Test public void canonicalizesOriginsWithoutSecrets() {
        assertEquals("https://studio.example.com", HostOrigin.parse(" HTTPS://Studio.Example.com:443/ "));
        assertEquals("https://localhost:8443", HostOrigin.parse("https://localhost:8443"));
        assertEquals("https://127.0.0.1", HostOrigin.parse("https://127.0.0.1"));
        assertEquals("https://[::1]:8443", HostOrigin.parse("https://[::1]:8443/"));
    }

    @Test public void rejectsNonOrigins() {
        invalid(null, HostOrigin.Error.REQUIRED);
        invalid("  ", HostOrigin.Error.REQUIRED);
        invalid("http://host", HostOrigin.Error.HTTPS);
        invalid("javascript:alert(1)", HostOrigin.Error.HTTPS);
        invalid("https://user:secret@host", HostOrigin.Error.CREDENTIALS);
        invalid("https://host/mobile", HostOrigin.Error.ORIGIN_ONLY);
        invalid("https://host/%2f", HostOrigin.Error.ORIGIN_ONLY);
        invalid("https://host/..", HostOrigin.Error.ORIGIN_ONLY);
        invalid("https://host?", HostOrigin.Error.ORIGIN_ONLY);
        invalid("https://host#key", HostOrigin.Error.ORIGIN_ONLY);
        invalid("https://host:0", HostOrigin.Error.PORT);
        invalid("https://host:65536", HostOrigin.Error.PORT);
        invalid("https://host:", HostOrigin.Error.INVALID);
        invalid("https://host:abc", HostOrigin.Error.INVALID);
        invalid("https://host\\@evil", HostOrigin.Error.INVALID);
        invalid("https://", HostOrigin.Error.INVALID);
        invalid("https:///mobile", HostOrigin.Error.ORIGIN_ONLY);
        invalid("https://host name", HostOrigin.Error.INVALID);
    }

    @Test public void navigationRequiresExactHttpsOrigin() {
        String origin = "https://studio.example.com";
        assertTrue(HostOrigin.contains(origin, "https://STUDIO.example.com:443/mobile?view=chat#thread"));
        assertTrue(HostOrigin.contains(origin, origin + "/api/mobile/login"));
        for (String url : new String[] {
                "http://studio.example.com", "https://studio.example.com:8443",
                "https://studio.example.com.evil", "https://evil@studio.example.com",
                "https://studio.example.com@evil", "javascript:alert(1)", "file:///secret",
                "content://settings", "intent://host", "https://host\\path", "about:blank", null }) {
            assertFalse(String.valueOf(url), HostOrigin.contains(origin, url));
        }
    }

    @Test public void browserOnlyReceivesHttpOrHttpsWithoutUserInfo() {
        assertTrue(HostOrigin.isBrowserLink("https://github.com/login?return_to=%2F"));
        assertTrue(HostOrigin.isBrowserLink("http://example.com/docs"));
        for (String url : new String[] { "intent://app", "mailto:x@example.com", "tel:123",
                "javascript:alert(1)", "file:///secret", "https://secret@host", "http:///path", null }) {
            assertFalse(String.valueOf(url), HostOrigin.isBrowserLink(url));
        }
    }

    private void invalid(String value, HostOrigin.Error error) {
        try {
            HostOrigin.parse(value);
            fail("Expected invalid origin");
        } catch (HostOrigin.InvalidOrigin exception) {
            assertEquals(error, exception.error);
            assertFalse(exception.getMessage().contains("secret"));
        }
    }
}
