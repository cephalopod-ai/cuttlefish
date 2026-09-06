# Pinned to cuttlefish-cli-0.23.6.tgz, the newest version published to npm
# (2026-07-25; verified live with a matching sha256 on 2026-09-06). The
# v0.23.7 GitHub Release never reached npm (publish authority failed), so
# the formula correctly stays at 0.23.6. bump-formula.yml overwrites this
# url/sha256 after each successful npm publish - do not hand-edit it.
class Cuttlefish < Formula
  desc "Lightweight AI gateway daemon orchestrating professional AI coding CLIs"
  homepage "https://github.com/cephalopod-ai/cuttlefish"
  url "https://registry.npmjs.org/cuttlefish-cli/-/cuttlefish-cli-0.23.6.tgz"
  sha256 "f70b535f6bf430a011ee91debe9858bcfca001a874c55e58839b7302452f298e"
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
