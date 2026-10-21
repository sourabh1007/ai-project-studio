package com.sourabh1007.aiprojectstudio.preview;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class HostOrigin {
    enum Error { REQUIRED, INVALID, HTTPS, CREDENTIALS, ORIGIN_ONLY, PORT }

    static final class InvalidOrigin extends IllegalArgumentException {
        final Error error;

        InvalidOrigin(Error error) {
            super(error.name());
            this.error = error;
        }
    }

    private HostOrigin() {}

    static String parse(String input) {
        if (input == null || input.trim().isEmpty()) throw new InvalidOrigin(Error.REQUIRED);
        URI uri = uri(input.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme())) throw new InvalidOrigin(Error.HTTPS);
        if (uri.getRawUserInfo() != null) throw new InvalidOrigin(Error.CREDENTIALS);
        if (uri.getRawQuery() != null || uri.getRawFragment() != null
                || (uri.getRawPath() != null && !uri.getRawPath().isEmpty()
                && !"/".equals(uri.getRawPath()))) {
            throw new InvalidOrigin(Error.ORIGIN_ONLY);
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty() || uri.isOpaque()
                || uri.getRawAuthority().endsWith(":") || host.contains("%")) {
            throw new InvalidOrigin(Error.INVALID);
        }
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) throw new InvalidOrigin(Error.PORT);
        return "https://" + host.toLowerCase(Locale.ROOT)
                + (port == -1 || port == 443 ? "" : ":" + port);
    }

    static boolean contains(String origin, String url) {
        try {
            URI uri = uri(url);
            if (uri.getRawUserInfo() != null || !"https".equalsIgnoreCase(uri.getScheme())
                    || uri.getHost() == null || uri.getHost().contains("%")) return false;
            String authority = "https://" + uri.getHost()
                    + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
            return parse(authority).equals(origin);
        } catch (IllegalArgumentException exception) {
            return false;
        }
    }

    static boolean isBrowserLink(String url) {
        try {
            URI uri = uri(url);
            return ("https".equalsIgnoreCase(uri.getScheme())
                    || "http".equalsIgnoreCase(uri.getScheme()))
                    && uri.getHost() != null && uri.getRawUserInfo() == null;
        } catch (IllegalArgumentException exception) {
            return false;
        }
    }

    private static URI uri(String input) {
        try {
            return new URI(input);
        } catch (URISyntaxException | NullPointerException exception) {
            throw new InvalidOrigin(Error.INVALID);
        }
    }
}
