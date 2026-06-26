from pathlib import Path


def test_monorepo_package_tests_are_present() -> None:
    root = Path(__file__).resolve().parents[1]

    assert (root / "packages" / "cuttlefish").is_dir()
    assert (root / "packages" / "web").is_dir()
