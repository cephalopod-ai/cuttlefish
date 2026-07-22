# No published npm release exists as of 2026-07-22. The previous entry
# (cuttlefish-cli-0.1.0.tgz, bumped by CI on 2026-07-21) pointed at a
# tarball that briefly existed on the npm registry and now 404s there;
# `brew install` against that URL fails. See
# .giles/feature-ledger/giles-ledger-0087-release-cuttlefish-cli-v0.23.4-20260722.md
# for details. bump-formula.yml will overwrite this url/sha256 once a
# real npm publish succeeds - do not hand-edit past that point.
class Cuttlefish < Formula
  desc "Lightweight AI gateway daemon orchestrating professional AI coding CLIs"
  homepage "https://github.com/cephalopod-ai/cuttlefish"
  url "https://registry.npmjs.org/cuttlefish-cli/-/cuttlefish-cli-PLACEHOLDER.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/cuttlefish-cli"
    regex(/"latest":\s*"(\d+(?:\.\d+)+)"/)
  end

  depends_on "node@24"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To get started, run:
        cuttlefish setup

      Then start the gateway daemon:
        cuttlefish start

      The web dashboard will be available at http://localhost:8888
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cuttlefish --version")
    assert_match "Usage", shell_output("#{bin}/cuttlefish --help")

    cd libexec/"lib/node_modules/cuttlefish-cli" do
      system "node", "-e", "require('better-sqlite3')"
    end
  end
end
