class Cuttlefish < Formula
  desc "Lightweight AI gateway daemon orchestrating Claude Code and Codex"
  homepage "https://github.com/e3742526/cuttlefish"
  url "https://registry.npmjs.org/cuttlefish-cli/-/cuttlefish-cli-0.23.3.tgz"
  sha256 "57eac4d0c1d2116585660653253ef76433635bc3192a040bae13e15f11bbef21"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/cuttlefish-cli"
    regex(/"latest":\s*"(\d+(?:\.\d+)+)"/)
  end

  depends_on "node@22"
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
      system "node", "-e", "require('classic-level')"
    end
  end
end
