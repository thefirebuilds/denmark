# Deploy Fresh Coast Garage

The Denmark production workflow deploys the public site as the `freshcoastgarage` Compose service from the same container image. It uses the site files in `freshcoastgarage/` and binds to `127.0.0.1:5080` on the droplet. The deploy verifies the homepage, validates the live fleet against the site roster, and checks that private Denmark routes are unavailable on the garage listener.

## Preview before changing DNS

Open an SSH tunnel to the same droplet used by the Denmark workflow.

```sh
ssh -N -L 5080:127.0.0.1:5080 USER@DROPLET
```

Visit `http://localhost:5080/` and `http://localhost:5080/api/public/availability` to verify the site and available cars. The site uses this same-origin feed and shows its offline roster if Denmark is temporarily unavailable.

## Route the public domains

Add this block to the droplet's edge Caddyfile when Caddy runs on the host. If Caddy runs in a container, connect it to the Denmark Compose network and use `freshcoastgarage:5080` as the upstream instead.

```caddyfile
freshcoastgarage.com {
    redir https://www.freshcoastgarage.com{uri} permanent
}

www.freshcoastgarage.com {
    reverse_proxy 127.0.0.1:5080
}
```

Validate the edge config, point both names at the droplet, and reload Caddy. Verify HTTPS, the home page and legal pages, and the live fleet feed. Keep the old host and Denmark's snapshot push configured during cutover so a DNS rollback can still use current data. After the new site is verified, disable **Public availability push** in Denmark's integration settings.
