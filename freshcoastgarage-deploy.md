# Deploy Fresh Coast Garage

The Denmark production workflow deploys the public site as the `freshcoastgarage` Compose service from the same container image. It uses the site files in `freshcoastgarage/` and binds to `127.0.0.1:5080` on the droplet. The deploy verifies the homepage, validates the live fleet against the site roster, and checks that private Denmark routes are unavailable on the garage listener.

## Preview before changing DNS

Open an SSH tunnel to the same droplet used by the Denmark workflow.

```sh
ssh -N -L 5080:127.0.0.1:5080 USER@DROPLET
```

Visit `http://localhost:5080/` and `http://localhost:5080/api/public/availability` to verify the site and available cars. If the feed is temporarily unavailable, the site shows an offline message.

## Preview through Nginx before DNS

The deploy installs a named HTTP route for both garage domains and verifies it through Nginx. The bare IP continues to serve Denmark. Test the garage route without changing DNS by resolving its hostname to the droplet for one request.

```sh
curl --resolve www.freshcoastgarage.com:80:159.223.151.27 http://www.freshcoastgarage.com/
```

## Switch DNS and verify HTTPS

Point both names at the droplet and configure HTTPS for both names on Nginx or through your existing Cloudflare setup. Verify HTTPS, the home page and legal pages, and the live fleet feed. Keep the old host and Denmark's snapshot push configured during cutover so a DNS rollback can still use current data. After the new site is verified, disable **Public availability push** in Denmark's integration settings.
