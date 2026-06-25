const express = require("express");
const fs = require("fs");
const path = require("path");

function installStaticClient(app) {
  const clientDistPath = path.resolve(__dirname, "../../dist");
  const clientIndexPath = path.join(clientDistPath, "index.html");

  if (fs.existsSync(clientIndexPath)) {
    app.use(express.static(clientDistPath));
    app.get(/^(?!\/api(?:\/|$)|\/__whoami$).*/, (req, res) => {
      res.sendFile(clientIndexPath);
    });
  }
}

module.exports = {
  installStaticClient,
};
