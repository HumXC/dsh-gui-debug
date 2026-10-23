{
  description = "Development environment for DeepSeek Harness plugins";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm

              # Development-only GUI backends and their screenshot/input tools.
              pkgs.cage
              pkgs.sway
              pkgs.grim
              pkgs.wtype
              pkgs.wlrctl
              pkgs.wayland-utils
              pkgs.wlr-randr

              # Small native Wayland application for keyboard/pointer smoke tests.
              pkgs.foot
            ];
          };
        });
    };
}
