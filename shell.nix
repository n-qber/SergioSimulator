{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  name = "sergio-simulator-env";
  buildInputs = with pkgs; [
    nodejs_22
    firebase-tools
  ];

  shellHook = ''
    echo "=========================================="
    echo "🥁 Sérgio Simulator - Dev Environment"
    echo "Node: $(node -v)"
    echo "=========================================="
  '';
}
